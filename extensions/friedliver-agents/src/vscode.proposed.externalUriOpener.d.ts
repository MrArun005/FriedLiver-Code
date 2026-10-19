// From microsoft/vscode src/vscode-dts/vscode.proposed.externalUriOpener.d.ts (MIT), the parts FriedLiver uses:
// links opened anywhere in the editor (markdown, hovers, terminal) can go to FriedLiver's browser. FriedLiver enables the proposal.

declare module 'vscode' {
	export enum ExternalUriOpenerPriority {
		None = 0,
		Option = 1,
		Default = 2,
		Preferred = 3,
	}

	export interface ExternalUriOpener {
		canOpenExternalUri(uri: Uri, token: CancellationToken): ExternalUriOpenerPriority | Thenable<ExternalUriOpenerPriority>;
		openExternalUri(resolvedUri: Uri, ctx: OpenExternalUriContext, token: CancellationToken): Thenable<void> | void;
	}

	export interface OpenExternalUriContext {
		readonly sourceUri: Uri;
	}

	export interface ExternalUriOpenerMetadata {
		readonly schemes: readonly string[];
		readonly label: string;
	}

	export namespace window {
		export function registerExternalUriOpener(id: string, opener: ExternalUriOpener, metadata: ExternalUriOpenerMetadata): Disposable;
	}

	export interface OpenExternalOptions {
		readonly allowContributedOpeners?: boolean | string;
	}

	export namespace env {
		export function openExternal(target: Uri, options?: OpenExternalOptions): Thenable<boolean>;
	}
}
