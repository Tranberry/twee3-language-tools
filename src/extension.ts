//#region Imports
import * as vscode from 'vscode';
import { v4 as uuidv4 } from 'uuid';

import { parseText, DocumentSemanticTokensProvider, legend } from './parse-text';
import { updateDiagnostics } from './diagnostics';
import { tweeProjectConfig, changeStoryFormat } from './twee-project';

import { sendPassageDataToClient, toUpdatePassage, updatePassages, focusPassage } from "./story-map/socket";
import { startUI, stopUI, storyMapIO } from "./story-map/index";

import { fileGlob } from './file-ops';

import { PassageSymbolProvider, PassageListProvider, Passage, jumpToPassage, WorkspacePassageSymbolProvider } from './passage';

import * as formatting from "./formatting";

import * as sc2m from './sugarcube-2/macros';
import * as sc2ca from './sugarcube-2/code-actions';
import { packer } from './story-map/packer';

import { passageCounter } from './status-bar'
import { sbStoryMapConfirmationDialog } from './status-bar';
import { updateDecorations, updateTextEditorDecorations } from './decorations';
//#endregion

const documentSelector: vscode.DocumentSelector = {
	pattern: "**/*.{tw,twee}",
};

export async function activate(ctx: vscode.ExtensionContext) {
	vscode.commands.executeCommand('setContext', 't3lt.extensionActive', true);

	const sbPassageCounter = passageCounter(ctx);

	const passageListProvider = new PassageListProvider(ctx);
	const collection = vscode.languages.createDiagnosticCollection();

	if (!ctx.workspaceState.get("StoryData")) {
		await ctx.workspaceState.update("StoryData", {});
	}

	function start() {
		collection.clear();
		return ctx.workspaceState.update("passages", undefined);
	}

	await start();

	async function prepare() {
		const fg = fileGlob();

		for (const file of fg) {
			const doc = await vscode.workspace.openTextDocument(file);

			await parseText(ctx, doc);
			passageCounter(ctx, sbPassageCounter);

			if (vscode.workspace.getConfiguration("twee3LanguageTools.passage").get("list")) passageListProvider.refresh();
		}

		await tweeProjectConfig(ctx);

		for (const file of fg) {
			const doc = await vscode.workspace.openTextDocument(file);
			await changeStoryFormat(doc);
			updateDiagnostics(ctx, doc, collection);
		}
	}

	await prepare();

	const storyMap: storyMapIO = { client: undefined, server: undefined, disconnectTimeout: undefined };

	const startUIWrapper = () => startUI(ctx, storyMap);
	const stopUIWrapper = () => stopUI(storyMap);

	const mapShowCommand = vscode.commands.registerCommand("twee3LanguageTools.storyMap.show", startUIWrapper);
	const mapStopCommand = vscode.commands.registerCommand("twee3LanguageTools.storyMap.stop", stopUIWrapper);

	const passageList = vscode.window.createTreeView("t3lt-passages-list", {
		showCollapseAll: true,
		treeDataProvider: passageListProvider
	});

	ctx.subscriptions.push(
		mapShowCommand, mapStopCommand, sbPassageCounter,
		vscode.languages.registerDocumentSemanticTokensProvider(documentSelector, new DocumentSemanticTokensProvider(ctx), legend)
		,
		vscode.languages.registerDocumentSymbolProvider(documentSelector, new PassageSymbolProvider(ctx))
		,
		vscode.languages.registerWorkspaceSymbolProvider(new WorkspacePassageSymbolProvider(ctx))
		,
		vscode.languages.registerHoverProvider(documentSelector, {
			provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): vscode.ProviderResult<vscode.Hover> {
				if (document.languageId == "twee3-sugarcube-2") {
					return sc2m.hover(document, position);
				} else {
					return null;
				}
			}
		})
		,
		vscode.window.onDidChangeTextEditorSelection(async e => {
			if (e.textEditor.document.languageId === "twee3-sugarcube-2" && vscode.workspace.getConfiguration("twee3LanguageTools.sugarcube-2.features").get("macroTagMatching")) {
				let collected = await sc2m.collectCache.get(e.textEditor.document);
				let r: vscode.Range[] = [];
				e.selections.forEach(sel => {
					let pos = sel.active;
					let target = collected.macros
						.filter(el => el.open && el.id !== el.pair).reverse()
						.find(el => (new vscode.Range(el.range.start, collected.macros[el.pair].range.end)).contains(pos));
					if (target) {
						r.push(target.range, collected.macros[target.pair].range);
					}
				});
				e.textEditor.setDecorations(sc2m.macroTagMatchingDecor, r);
			}
		})
		,
		vscode.window.onDidChangeActiveTextEditor(editor => {
			if (editor && /^twee3.*/.test(editor.document.languageId)) {
				updateDiagnostics(ctx, editor.document, collection);
				updateDecorations(ctx, editor);
			}
		})
		,
		vscode.workspace.onDidOpenTextDocument(async document => {
			if (!/^twee3.*/.test(document.languageId)) return;
			await changeStoryFormat(document);
			updateDiagnostics(ctx, document, collection);
			updateTextEditorDecorations(ctx);
		})
		,
		vscode.workspace.onDidChangeTextDocument(e => {
			if (!/^twee3.*/.test(e.document.languageId)) return;
			updateDiagnostics(ctx, e.document, collection);
			updateTextEditorDecorations(ctx);
		})
		,
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration("twee3LanguageTools.storyformat")) {
				fileGlob().forEach(async file => {
					const doc = await vscode.workspace.openTextDocument(file);
					await changeStoryFormat(doc);
					updateDiagnostics(ctx, doc, collection);
				});
			}
			if (e.affectsConfiguration("twee3LanguageTools.passage")) {
				passageListProvider.refresh();
			}
			if (e.affectsConfiguration("twee3LanguageTools.directories")) {
				start().then(prepare);
			}
			if (e.affectsConfiguration("twee3LanguageTools.sugarcube-2.cache.argumentInformation") && !vscode.workspace.getConfiguration("twee3LanguageTools.sugarcube-2.cache").get(".argumentInformation")) {
				// The configuration for this setting has been changed and it is now false, so we
				// clear the cache.
				sc2m.argumentCache.clear();
			}
			if (e.affectsConfiguration("twee3LanguageTools.sugarcube-2.error.parameterValidation")) {
				// Note: We simply clear the arguments cache to force it to revalidate.
				// This could be done in a more efficient manner, but this is good enough.
				sc2m.argumentCache.clear();
			}
			if (e.affectsConfiguration("twee3LanguageTools.sugarcube-2.warning.barewordLinkPassageChecking")) {
				sc2m.argumentCache.clearMacrosUsingPassage();
			}
			if (e.affectsConfiguration("twee3LanguageTools.sugarcube-2.definedMacroDecorations")) {
				updateTextEditorDecorations(ctx);
			}
		})
		,
		vscode.workspace.onDidCreateFiles(e => {
			e.files.forEach(file => vscode.workspace.openTextDocument(file).then((doc) => changeStoryFormat(doc)));
		})
		,
		vscode.workspace.onDidDeleteFiles(e => {
			e.files.forEach(file => sc2m.collectCache.clearFilename(file.fsPath));

			const removedFilePaths = e.files.map((file) => file.path);
			const oldPassages: Passage[] = ctx.workspaceState.get("passages", []);
			const newPassages: Passage[] = oldPassages.filter((passage) => !removedFilePaths.includes(passage.origin.full));
			ctx.workspaceState.update("passages", newPassages).then(() => {
				if (storyMap.client) sendPassageDataToClient(ctx, storyMap.client);
				passageListProvider.refresh();
			});
		})
		,
		vscode.workspace.onDidRenameFiles(async e => {
			for (let file of e.files) {
				let doc = await vscode.workspace.openTextDocument(file.newUri);
				changeStoryFormat(doc);

				sc2m.collectCache.clearFilename(file.oldUri.fsPath);

				let passages: Passage[] = ctx.workspaceState.get("passages", []);
				passages.forEach(el => {
					if (el.origin.full === file.oldUri.path) {
						el.origin.root = vscode.workspace.getWorkspaceFolder(file.newUri)?.uri.path || "";
						el.origin.path = file.newUri.path.replace(el.origin.root, "");
						el.origin.full = file.newUri.path;
					}
				});
				await ctx.workspaceState.update("passages", passages);
				if (vscode.workspace.getConfiguration("twee3LanguageTools.passage").get("list")) passageListProvider.refresh();
				if (storyMap.client) sendPassageDataToClient(ctx, storyMap.client);
			}
		})
		,
		vscode.workspace.onDidSaveTextDocument(async document => {
			if (!/^twee3.*/.test(document.languageId)) return;

			await parseText(ctx, document);
			passageCounter(ctx, sbPassageCounter);

			if (vscode.workspace.getConfiguration("twee3LanguageTools.passage").get("list")) passageListProvider.refresh();
			if (storyMap.client) sendPassageDataToClient(ctx, storyMap.client);

			tweeProjectConfig(ctx);
		})
		,
		vscode.commands.registerCommand("twee3LanguageTools.refreshDiagnostics", () => {
			const doc = vscode.window.activeTextEditor?.document;
			if (doc) updateDiagnostics(ctx, doc, collection);
		})
		,
		vscode.commands.registerCommand("twee3LanguageTools.passage.pack", async () => {
			const proceed = await vscode.window.showWarningMessage(
				`This action replaces position data for all passages in workspace. It will also overwrite any unsaved changes.`,
				"Proceed"
			);
			if (proceed === "Proceed") {
				const passages = ctx.workspaceState.get("passages") as Passage[];
				updatePassages(ctx, packer(passages).map((p: Passage) => toUpdatePassage(p)));
			}
		})
		,
		vscode.commands.registerCommand("twee3LanguageTools.passage.jump", (item: Passage) => {
			jumpToPassage(item);
		})
		,
		vscode.commands.registerCommand("twee3LanguageTools.passage.list", () => {
			const config = vscode.workspace.getConfiguration("twee3LanguageTools.passage");
			config.update("list", !config.get("list"));
		})
		,
		vscode.commands.registerCommand("twee3LanguageTools.passage.group.none", () => {
			vscode.workspace.getConfiguration("twee3LanguageTools.passage").update("group", "None");
		})
		,
		vscode.commands.registerCommand("twee3LanguageTools.passage.group.file", () => {
			vscode.workspace.getConfiguration("twee3LanguageTools.passage").update("group", "File");
		})
		,
		vscode.commands.registerCommand("twee3LanguageTools.passage.group.folder", () => {
			vscode.workspace.getConfiguration("twee3LanguageTools.passage").update("group", "Folder");
		})
		,
		vscode.commands.registerCommand("twee3LanguageTools.passage.group.tag", () => {
			vscode.workspace.getConfiguration("twee3LanguageTools.passage").update("group", "Tag");
		})
		,
		vscode.commands.registerCommand("twee3LanguageTools.ifid.generate", () => {
			vscode.window.activeTextEditor?.insertSnippet(new vscode.SnippetString(uuidv4().toUpperCase()));
		})
		,
		vscode.commands.registerCommand("twee3LanguageTools.sc2.defineMacro", sc2ca.unrecognizedMacroFixCommand)
		,
		vscode.commands.registerCommand("twee3LanguageTools.sc2.clearArgumentCache", () => {
			// Provide a command to clear the argument cache for if there is ever any bugs with the
			// implementation, it can tide users over until a fix.
			sc2m.argumentCache.clear();
		})
		,
		vscode.commands.registerCommand("twee3LanguageTools.sc2.addAllUnrecognizedMacros", () => {
			sc2ca.addAllUnrecognizedMacros();
		})
		,
		vscode.commands.registerCommand("twee3LanguageTools.sc2.addAllUnrecognizedMacrosInFile", async() => {
			let editor = vscode.window.activeTextEditor;
			if (editor) {
				await sc2ca.addAllUnrecognizedMacrosInCurrentFile(editor.document);
			}
		})
		,
		vscode.commands.registerTextEditorCommand("twee3LanguageTools.storyMap.focusPassage", (editor) => focusPassage(ctx, storyMap, editor))
		,
		// TODO: Allow configuration for which version Harlowe should use since it supports both ''
		// and ** for bold, and // and * for italics
		vscode.commands.registerTextEditorCommand("twee3LanguageTools.toggleItalics", editor => {
			let languageId = editor.document.languageId;
			if (languageId === "twee3-sugarcube-2") {
				formatting.styleByWrapping(editor, "//");
			} else if (languageId === "twee3-harlowe-3") {
				formatting.styleByWrapping(editor, "*");
			}
			// TODO: Other story format support
		})
		,
		vscode.commands.registerTextEditorCommand("twee3LanguageTools.toggleBold", (editor, edit) => {
			let languageId = editor.document.languageId;
			if (languageId === "twee3-sugarcube-2") {
				formatting.styleByWrapping(editor, "''");
			}  else if (languageId === "twee3-harlowe-3") {
				formatting.styleByWrapping(editor, "**");
			}
			// TODO: Other story format support
		})
		,
		vscode.languages.registerCodeActionsProvider("twee3-sugarcube-2", new sc2ca.EndMacro(), {
			providedCodeActionKinds: sc2ca.EndMacro.providedCodeActionKinds
		})
		,
		vscode.languages.registerCodeActionsProvider("twee3-sugarcube-2", new sc2ca.Unrecognized(), {
			providedCodeActionKinds: sc2ca.Unrecognized.providedCodeActionKinds
		})
		,
		vscode.commands.registerCommand("twee3LanguageTools.passageCounter.clickCheck", sbStoryMapConfirmationDialog)
	);

	// This is needed so that on first load, the active file will get colors.
	updateTextEditorDecorations(ctx);
};