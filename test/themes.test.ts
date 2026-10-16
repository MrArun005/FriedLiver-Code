import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The VS Code fork's built-in theme extension (code/extensions/friedliver-theme).
const EXT = path.join(__dirname, '..', 'code', 'extensions', 'friedliver-theme');

interface ThemeContribution {
  id: string;
  label: string;
  uiTheme: string;
  path: string;
}
interface TokenRule {
  name?: string;
  scope: string | string[];
  settings: { foreground?: string; fontStyle?: string };
}
interface ColorTheme {
  name: string;
  type: 'dark' | 'light';
  colors: Record<string, string>;
  tokenColors: TokenRule[];
  semanticTokenColors: Record<string, string | { foreground?: string }>;
}

const manifest = JSON.parse(readFileSync(path.join(EXT, 'package.json'), 'utf8')) as {
  contributes: { themes: ThemeContribution[]; configurationDefaults: Record<string, unknown> };
};
const THEMES = manifest.contributes.themes.map((contribution) => ({
  contribution,
  theme: JSON.parse(readFileSync(path.join(EXT, contribution.path), 'utf8')) as ColorTheme,
}));

// WCAG 2.1 relative luminance and contrast ratio (same approach as palettes.test.ts).
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
/** Composites a `#rrggbbaa` color over an opaque `#rrggbb` base; opaque colors pass through. */
function flatten(color: string, base: string): string {
  if (color.length === 7) return color;
  const alpha = parseInt(color.slice(7, 9), 16) / 255;
  const channel = (hex: string, i: number) => parseInt(hex.slice(i, i + 2), 16);
  return '#' + [1, 3, 5].map((i) => Math.round(channel(color, i) * alpha + channel(base, i) * (1 - alpha)).toString(16).padStart(2, '0')).join('');
}

/** [foreground key, background key, surface the background sits on when translucent]. */
const TEXT_PAIRS: [string, string, string?][] = [
  ['editor.foreground', 'editor.background'],
  ['editorLineNumber.foreground', 'editor.background'],
  ['editorLineNumber.activeForeground', 'editor.background'],
  ['terminal.foreground', 'terminal.background'],
  ['foreground', 'panel.background'],
  ['descriptionForeground', 'sideBar.background'],
  ['descriptionForeground', 'editor.background'],
  ['sideBar.foreground', 'sideBar.background'],
  ['sideBarTitle.foreground', 'sideBar.background'],
  ['sideBarSectionHeader.foreground', 'sideBarSectionHeader.background'],
  ['activityBar.foreground', 'activityBar.activeBackground'],
  ['activityBar.inactiveForeground', 'activityBar.background'],
  ['panelTitle.activeForeground', 'panel.background'],
  ['panelTitle.inactiveForeground', 'panel.background'],
  ['statusBar.foreground', 'statusBar.background'],
  ['statusBar.noFolderForeground', 'statusBar.noFolderBackground'],
  ['statusBar.debuggingForeground', 'statusBar.debuggingBackground'],
  ['statusBarItem.remoteForeground', 'statusBarItem.remoteBackground'],
  ['statusBarItem.remoteHoverForeground', 'statusBarItem.remoteHoverBackground'],
  ['statusBarItem.prominentForeground', 'statusBarItem.prominentBackground'],
  ['statusBarItem.errorForeground', 'statusBarItem.errorBackground'],
  ['statusBarItem.warningForeground', 'statusBarItem.warningBackground'],
  ['statusBarItem.offlineForeground', 'statusBarItem.offlineBackground'],
  ['statusBarItem.hoverForeground', 'statusBarItem.hoverBackground'],
  ['tab.activeForeground', 'tab.activeBackground'],
  ['tab.inactiveForeground', 'tab.inactiveBackground'],
  ['tab.hoverForeground', 'tab.hoverBackground'],
  ['tab.unfocusedActiveForeground', 'tab.unfocusedActiveBackground'],
  ['tab.unfocusedInactiveForeground', 'tab.unfocusedInactiveBackground'],
  ['breadcrumb.foreground', 'breadcrumb.background'],
  ['breadcrumb.focusForeground', 'breadcrumb.background'],
  ['titleBar.activeForeground', 'titleBar.activeBackground'],
  ['titleBar.inactiveForeground', 'titleBar.inactiveBackground'],
  ['commandCenter.foreground', 'commandCenter.background'],
  ['commandCenter.activeForeground', 'commandCenter.activeBackground'],
  ['list.activeSelectionForeground', 'list.activeSelectionBackground'],
  ['list.inactiveSelectionForeground', 'list.inactiveSelectionBackground'],
  ['list.focusForeground', 'list.focusBackground'],
  ['list.hoverForeground', 'list.hoverBackground', 'sideBar.background'],
  ['input.foreground', 'input.background'],
  ['input.placeholderForeground', 'input.background'],
  ['dropdown.foreground', 'dropdown.background'],
  ['dropdown.foreground', 'dropdown.listBackground'],
  ['checkbox.foreground', 'checkbox.background'],
  ['inputOption.activeForeground', 'inputOption.activeBackground'],
  ['button.foreground', 'button.background'],
  ['button.foreground', 'button.hoverBackground'],
  ['button.secondaryForeground', 'button.secondaryBackground'],
  ['button.secondaryForeground', 'button.secondaryHoverBackground'],
  ['extensionButton.prominentForeground', 'extensionButton.prominentBackground'],
  ['extensionButton.foreground', 'extensionButton.background'],
  ['badge.foreground', 'badge.background'],
  ['activityBarBadge.foreground', 'activityBarBadge.background'],
  ['activityErrorBadge.foreground', 'activityErrorBadge.background'],
  ['activityWarningBadge.foreground', 'activityWarningBadge.background'],
  ['panelTitleBadge.foreground', 'panelTitleBadge.background'],
  ['keybindingLabel.foreground', 'keybindingLabel.background'],
  ['notifications.foreground', 'notifications.background'],
  ['notificationCenterHeader.foreground', 'notificationCenterHeader.background'],
  ['notificationLink.foreground', 'notifications.background'],
  ['banner.foreground', 'banner.background'],
  ['quickInput.foreground', 'quickInput.background'],
  ['quickInputList.focusForeground', 'quickInputList.focusBackground'],
  ['pickerGroup.foreground', 'quickInput.background'],
  ['menu.foreground', 'menu.background'],
  ['menu.selectionForeground', 'menu.selectionBackground'],
  ['menubar.selectionForeground', 'menubar.selectionBackground'],
  ['editorWidget.foreground', 'editorWidget.background'],
  ['editorSuggestWidget.foreground', 'editorSuggestWidget.background'],
  ['editorSuggestWidget.selectedForeground', 'editorSuggestWidget.selectedBackground'],
  ['editorHoverWidget.foreground', 'editorHoverWidget.background'],
  ['editorInlayHint.foreground', 'editorInlayHint.background', 'editor.background'],
  ['peekViewTitleLabel.foreground', 'peekViewTitle.background'],
  ['peekViewResult.fileForeground', 'peekViewResult.background'],
  ['peekViewResult.selectionForeground', 'peekViewResult.selectionBackground'],
  ['debugView.exceptionLabelForeground', 'debugView.exceptionLabelBackground'],
  ['debugView.stateLabelForeground', 'debugView.stateLabelBackground'],
  ['textLink.foreground', 'editor.background'],
  ['textPreformat.foreground', 'textPreformat.background'],
  ['gitDecoration.modifiedResourceForeground', 'sideBar.background'],
  ['gitDecoration.addedResourceForeground', 'sideBar.background'],
  ['gitDecoration.deletedResourceForeground', 'sideBar.background'],
  ['gitDecoration.untrackedResourceForeground', 'sideBar.background'],
  ['gitDecoration.conflictingResourceForeground', 'sideBar.background'],
  ['gitDecoration.modifiedResourceForeground', 'list.activeSelectionBackground'],
  ['gitDecoration.addedResourceForeground', 'list.activeSelectionBackground'],
  ['gitDecoration.deletedResourceForeground', 'list.activeSelectionBackground'],
  ['list.errorForeground', 'sideBar.background'],
  ['list.warningForeground', 'sideBar.background'],
];

/** Icons and squiggles are graphics: WCAG 1.4.11 asks 3:1. */
const GRAPHIC_PAIRS: [string, string][] = [
  ['editorError.foreground', 'editor.background'],
  ['editorWarning.foreground', 'editor.background'],
  ['editorInfo.foreground', 'editor.background'],
  ['editorCursor.foreground', 'editor.background'],
  ['terminalCursor.foreground', 'terminal.background'],
  ['problemsErrorIcon.foreground', 'panel.background'],
  ['problemsWarningIcon.foreground', 'panel.background'],
  ['notificationsErrorIcon.foreground', 'notifications.background'],
  ['notificationsWarningIcon.foreground', 'notifications.background'],
  ['notificationsInfoIcon.foreground', 'notifications.background'],
  ['testing.iconPassed', 'sideBar.background'],
  ['testing.iconFailed', 'sideBar.background'],
  ['debugIcon.breakpointForeground', 'editor.background'],
  ['editorGutter.modifiedBackground', 'editor.background'],
  ['editorGutter.addedBackground', 'editor.background'],
  ['editorGutter.deletedBackground', 'editor.background'],
  ['icon.foreground', 'sideBar.background'],
];

const ANSI = ['Black', 'Red', 'Green', 'Yellow', 'Blue', 'Magenta', 'Cyan', 'White'].flatMap((c) => [`terminal.ansi${c}`, `terminal.ansiBright${c}`]);

describe.each(THEMES)('$contribution.label', ({ contribution, theme }) => {
  const color = (key: string): string => {
    const value = theme.colors[key];
    expect(value, `${key} is defined`).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/);
    return value;
  };

  it('names itself after its contribution and matches the uiTheme', () => {
    expect(theme.name).toBe(contribution.id);
    expect(theme.type).toBe(contribution.uiTheme === 'vs' ? 'light' : 'dark');
  });

  it('uses only #rrggbb or #rrggbbaa colors', () => {
    for (const [key, value] of Object.entries(theme.colors)) expect(value, key).toMatch(/^#[0-9a-f]{6}([0-9a-f]{2})?$/);
  });

  it.each(TEXT_PAIRS)('%s on %s meets 4.5:1', (fg, bg, under) => {
    const base = under ? color(under) : color('editor.background');
    const back = flatten(color(bg), base);
    expect(contrast(flatten(color(fg), back), back)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(GRAPHIC_PAIRS)('%s on %s meets 3:1', (fg, bg) => {
    const back = flatten(color(bg), color('editor.background'));
    expect(contrast(flatten(color(fg), back), back)).toBeGreaterThanOrEqual(3);
  });

  it('every terminal ANSI color is readable on the terminal background', () => {
    const back = color('terminal.background');
    for (const key of ANSI) {
      // Dark themes draw ANSI black as a near-background surface on purpose.
      if (theme.type === 'dark' && key === 'terminal.ansiBlack') continue;
      expect(contrast(color(key), back), key).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('every tokenColors foreground meets 4.5:1 on editor.background', () => {
    const back = color('editor.background');
    expect(theme.tokenColors.length).toBeGreaterThan(10);
    for (const rule of theme.tokenColors) {
      const fg = rule.settings.foreground;
      if (!fg) continue;
      expect(contrast(flatten(fg, back), back), String(rule.name ?? rule.scope)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('every semanticTokenColors foreground meets 4.5:1 on editor.background', () => {
    const back = color('editor.background');
    for (const [token, style] of Object.entries(theme.semanticTokenColors)) {
      const fg = typeof style === 'string' ? style : style.foreground;
      if (!fg) continue;
      expect(contrast(flatten(fg, back), back), token).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps comments upright', () => {
    const comments = theme.tokenColors.find((r) => [r.scope].flat().includes('comment'));
    expect(comments?.settings.fontStyle ?? '').not.toContain('italic');
  });
});

it('every theme defines the same color keys', () => {
  const keys = THEMES.map(({ theme }) => Object.keys(theme.colors).sort().join());
  expect(new Set(keys).size).toBe(1);
});

it('contributes four themes, with Black Blue as the default and Light Blue as the light preference', () => {
  expect(THEMES.map(({ contribution }) => contribution.id)).toEqual(['FriedLiver Black Blue', 'FriedLiver Light Blue', 'FriedLiver Midnight Blue', 'FriedLiver Graphite']);
  for (const { contribution } of THEMES) expect(existsSync(path.join(EXT, contribution.path))).toBe(true);
  const defaults = manifest.contributes.configurationDefaults;
  expect(defaults['workbench.colorTheme']).toBe('FriedLiver Black Blue');
  expect(defaults['workbench.preferredDarkColorTheme']).toBe('FriedLiver Black Blue');
  expect(defaults['workbench.preferredLightColorTheme']).toBe('FriedLiver Light Blue');
  expect(defaults['editor.fontFamily']).toBe("'Geist Mono', 'JetBrains Mono', 'Cascadia Code', Menlo, Consolas, monospace");
  expect(defaults['terminal.integrated.fontFamily']).toBe(defaults['editor.fontFamily']);
});

it('the committed theme files match palette.json', () => {
  // Fails with "stale: themes/..." when someone edits a theme JSON by hand or forgets to regenerate.
  expect(() => execFileSync(process.execPath, [path.join(EXT, 'scripts', 'generate-themes.mjs'), '--check'], { stdio: 'pipe' })).not.toThrow();
});
