import type {
  SourceId,
  AppSettings,
  CheckProgress,
  CheckResult,
  CreatorResult,
  InstallRecord,
  SeenEvent,
  UpdateSite,
} from './types.js';
import type { LocaleId } from './i18n/locales.js';

export type BrowserSite = 'loverslab' | 'patreon';

/** What a browser calls its private mode: a private, Incognito or InPrivate window. */
export type PrivateMode = 'private' | 'incognito' | 'inprivate';

export interface AccountStatus {
  site: BrowserSite;
  label: string;
  signedIn: boolean;
}

/** A browser that can open links in a private window. */
export interface LinkBrowser {
  id: string;
  name: string;
  privateMode: PrivateMode;
  isDefault: boolean;
}

export type BatchItemState = 'queued' | 'working' | 'done' | 'failed' | 'cancelled';

export interface BatchItem {
  key: string;
  name: string;
  /** Label of the source it downloads from, e.g. "wicked.cc". */
  source?: string;
  state: BatchItemState;
  message?: string;
  /** Files replaced and added, once installed. */
  replaced?: number;
  added?: number;
}

/** Progress of "Update all" (or automatic installs after a check). */
export interface BatchState {
  running: boolean;
  items: BatchItem[];
  stopRequested: boolean;
  /** Install records from this run carry the same id (for "Undo all"). */
  batchId?: string;
}

/** What setup found in the chosen folders, before the first check. */
export interface FolderPreview {
  creators: number;
  wickedWhims: boolean;
  otherFiles: number;
}

/** Disk space WhimWatch uses outside the Mods folder, in bytes. */
export interface StorageInfo {
  backups: number;
  /** Leftover downloads plus the LoversLab/Patreon web cache. */
  caches: number;
}

export interface OtherFile {
  path: string;
  relPath: string;
  error?: string;
}

export interface AppSnapshot {
  appVersion: string;
  dirs: string[];
  settings: AppSettings;
  lastResult?: CheckResult;
  running: boolean;
  progress?: CheckProgress;
  accounts: AccountStatus[];
  installs: InstallRecord[];
  /** Creator key → user-added links, for editing. */
  manualLinks: Record<string, string[]>;
  /** Creator key → pages the user added that nothing has read yet (see core/link-prefs.ts). */
  unreadLinks: Record<string, string[]>;
  /** Creator key → links the user removed. */
  rejectedLinks: Record<string, string[]>;
  /** Creator key → sites turned off for that creator only (see AppSettings.mutedSources for everyone). */
  creatorMutedSources: Record<string, UpdateSite[]>;
  /** Creator key → new files on their pages the user isn't interested in, by lower-case name. */
  ignoredFiles: Record<string, string[]>;
  browsers: LinkBrowser[];
  /** Folder that holds a backup subfolder for each update. */
  backupRoot: string;
  batch?: BatchState;
  /** Outcome of the last check when it didn't complete (cancelled or failed). */
  checkMessage?: { tone: 'info' | 'error'; text: string };
  /**
   * A newer WhimWatch release on GitHub. `hidden` means the user waved this version away: the
   * header chip stays down, but Settings still has to say you're behind rather than up to date.
   */
  appUpdate?: { version: string; url: string; hidden?: boolean };
  /** When GitHub was last asked. With no `appUpdate`, that check found nothing newer. */
  appUpdateCheckedAt?: number;
  /** Ids of game warnings the user hid. */
  dismissedGameWarnings: string[];
  /** The LoversLab/Patreon browsers keep nothing on disk this session. */
  sessionsInMemory: boolean;
  /** Linux without a usable keyring: sign-in cookies are only obfuscated on disk. */
  weakCookieStorage: boolean;
  /** "Mark as seen" actions, newest last. */
  seenHistory: SeenEvent[];
  /** The first check just finished: explain that hand-installed packs may look out of date. */
  firstCheckNotice: boolean;
  platform: 'win32' | 'darwin' | 'linux';
  /** The language everything is shown in: the Language setting, or the system's when that's "system". */
  locale: LocaleId;
  /** The language "system" resolves to, named in the Language setting. */
  systemLocale: LocaleId;
}

export interface PlannedFile {
  /** Path inside the extracted download. */
  source: string;
  /** Destination inside a Mods directory. */
  target: string;
  kind: 'replace' | 'add';
  /** Byte-identical to the installed file, so nothing needs copying. */
  unchanged?: boolean;
  /** For a replacement: the date of the user's copy, shown beside it so the two can be compared. */
  installedAt?: number;
}

export interface UpdatePlan {
  id: string;
  creatorKey: string;
  name: string;
  /** Page the update was downloaded from. */
  downloadUrl: string;
  source: SourceId;
  /** Names of the downloaded files (several when a page offers more than one). */
  downloads: string[];
  files: PlannedFile[];
  /** Installed files not present in the download (kept unless selected). */
  possiblyObsolete: string[];
  /** Files in the download that are not mods (readme etc.) and will be skipped. */
  skipped: string[];
  warnings: string[];
  /** The Sims 4 was running when the plan was made: installing waits until it's closed. */
  gameRunning?: boolean;
  /** Every downloaded mod file matches what's installed: nothing to update. */
  upToDate: boolean;
  /**
   * Up to date by the page's own dates, without downloading: every file of theirs on its list was
   * posted no later than their copy. Said so, since nothing was compared byte for byte.
   */
  byDate?: boolean;
  /**
   * The files of yours in the download are unchanged, and all it adds is files you don't have: most
   * likely a new pack put on the same page (a creator's Simlish edition, say), which the page's newer
   * date made look like an update. It can also be an update that only adds a file, so it's the
   * user's call: Update all leaves it alone and the Update window asks.
   */
  onlyAdds?: boolean;
  /**
   * Added files (targets) the user left out before, such as a no-sound edition re-uploaded with the
   * update: they start unticked, in the Update window and in Update all. A file with no such history
   * starts ticked, since it may be a companion the update needs.
   */
  startUnticked?: string[];
}

/** What the user picked in the update preview. */
export interface UpdateChoice {
  /** Installed files (from possiblyObsolete) to remove. */
  remove: string[];
  /** Planned targets to leave out. */
  skip: string[];
}

export type UpdateStage = 'resolving' | 'downloading' | 'extracting' | 'installing' | 'done' | 'error';

export interface UpdateProgress {
  creatorKey: string;
  stage: UpdateStage;
  received?: number;
  total?: number;
  message?: string;
}

export type AppEvent =
  | { type: 'snapshot'; snapshot: AppSnapshot }
  | { type: 'progress'; progress: CheckProgress }
  | { type: 'creator'; creator: CreatorResult }
  | { type: 'verification-needed'; site: BrowserSite }
  /** The user passed the site's human check, so it can be checked again. */
  | { type: 'verification-passed'; site: BrowserSite }
  | { type: 'update-progress'; progress: UpdateProgress }
  | { type: 'batch'; batch: BatchState }
  | { type: 'error'; message: string }
  /** Updates were installed automatically after a check. */
  | { type: 'auto-installed'; batchId: string; count: number }
  /** The quick-hide shortcut hid the window (the renderer drops any open menus). */
  | { type: 'hidden' }
  /** The window became active or inactive (for the privacy screen). */
  | { type: 'window-focus'; focused: boolean };

export interface WhimWatchApi {
  getSnapshot(): Promise<AppSnapshot>;
  detectModsDirs(): Promise<string[]>;
  chooseDirectory(): Promise<string | undefined>;
  setDirs(dirs: string[]): Promise<AppSnapshot>;
  updateSettings(patch: Partial<AppSettings>): Promise<AppSnapshot>;
  startCheck(): Promise<void>;
  /** Stops a running check; the previous results stay. */
  cancelCheck(): Promise<void>;
  dismiss(key: string, remoteUpdatedAt: number): Promise<AppSnapshot>;
  undismiss(key: string): Promise<AppSnapshot>;
  /** Marks every current update as seen. */
  dismissAll(): Promise<AppSnapshot>;
  /** Reverts a "Mark as seen" from History. */
  undoSeen(id: string): Promise<AppSnapshot>;
  dismissFirstCheckNotice(): Promise<AppSnapshot>;
  dismissAppUpdate(version: string): Promise<AppSnapshot>;
  /**
   * Asks GitHub for the latest release now, whatever the once-a-day gate and
   * the "tell me about new versions" setting say. Throws if GitHub can't be
   * reached; the answer is in the snapshot's `appUpdate`/`appUpdateCheckedAt`.
   */
  checkAppUpdate(): Promise<AppSnapshot>;
  /**
   * Marks one creator's (or WickedWhims') update as seen. With `listingUrl` for a page that names a
   * pack, only that pack is marked, so neither a newer post elsewhere nor an older pack of theirs
   * that is behind gets hidden with it. For a page that names no pack, the creator's whole update is
   * marked up to that page's date, as before.
   */
  markSeen(key: string, listingUrl?: string): Promise<AppSnapshot>;
  /** Hides a game warning until the game version changes. */
  dismissGameWarning(id: string): Promise<AppSnapshot>;
  addLink(key: string, url: string): Promise<AppSnapshot>;
  rejectLink(key: string, url: string): Promise<AppSnapshot>;
  /** Puts back the link removed by the last rejectLink (the undo in its toast). */
  undoRejectLink(key: string, url: string): Promise<AppSnapshot>;
  /** Puts back any removed page (see rejectedLinks); it's found again by the next check. */
  unrejectLink(key: string, url: string): Promise<AppSnapshot>;
  /** Turns one site off (or back on) for one creator. */
  setCreatorSite(key: string, site: UpdateSite, on: boolean): Promise<AppSnapshot>;
  /** "Not interested" in a new file on one of the creator's pages (RemoteInfo.newFiles), or its undo. */
  setFileIgnored(key: string, name: string, ignored: boolean): Promise<AppSnapshot>;
  openExternal(url: string): Promise<void>;
  /** Native context menu for a link: open, open privately, copy. */
  showLinkMenu(url: string): Promise<void>;
  /** Opens the backups folder, or one update's backup folder. */
  openBackupFolder(installId?: string): Promise<void>;
  showFile(path: string): Promise<void>;
  /** Files that aren't WickedWhims creator packages (not included in snapshots, which stay small). */
  listOtherFiles(): Promise<OtherFile[]>;
  showVerification(site: BrowserSite): Promise<void>;
  /** The user waved the notice away without passing the check: say it again when the site is next turned away. */
  dismissVerification(site: BrowserSite): Promise<void>;
  signIn(site: BrowserSite): Promise<AccountStatus>;
  signOut(site: BrowserSite): Promise<AccountStatus>;
  /** Downloads and prepares an update; `listingUrl` picks the source (default: newest downloadable). */
  /** With `fileName`, only that file from the page's list of files (see RemoteInfo.newFiles). */
  planUpdate(key: string, listingUrl?: string, fileName?: string, compareAnyway?: boolean): Promise<UpdatePlan>;
  applyUpdate(planId: string, choice: UpdateChoice): Promise<AppSnapshot>;
  undoInstall(id: string): Promise<AppSnapshot>;
  /** Undoes every install from one "Update all" (or automatic) run, newest first. */
  undoBatch(batchId: string): Promise<AppSnapshot>;
  isGameRunning(): Promise<boolean>;
  /** Whether the window is the active one right now. */
  isWindowFocused(): Promise<boolean>;
  /** Counts what setup found in these folders (also warms the scan cache for the first check). */
  previewDirs(dirs: string[]): Promise<FolderPreview>;
  /** Stops preparing an update (download/unpack) and throws away its files. Installing can't be interrupted. */
  cancelUpdate(key: string): Promise<void>;
  getStorage(): Promise<StorageInfo>;
  /** Versions, settings, the last check summary and recent log lines for a bug report, to preview. */
  getDiagnostics(): Promise<string>;
  /** Copies the diagnostics last shown by getDiagnostics. */
  copyDiagnostics(): Promise<void>;
  /** Saves the diagnostics last shown by getDiagnostics to a file the user picks; false if cancelled. */
  saveDiagnostics(): Promise<boolean>;
  /** WhimWatch's licence followed by the licences of everything it includes. */
  getLicenses(): Promise<string>;
  /** Asks for confirmation, then quits and deletes every WhimWatch file outside the Mods folder. */
  removeAllData(): Promise<void>;
  /** Deletes every update backup; those updates can no longer be undone. */
  clearBackups(): Promise<AppSnapshot>;
  /** Deletes leftover downloads and the web cache (keeps sign-ins). */
  clearCaches(): Promise<StorageInfo>;
  /** Starts updating these creators one after another; progress arrives as 'batch' events. */
  updateAll(keys: string[]): Promise<void>;
  /** Finishes the current item, then stops. */
  stopUpdateAll(): Promise<void>;
  /** Stops immediately (unless an install is mid-way, which finishes first). */
  cancelUpdateAll(): Promise<void>;
  onEvent(listener: (event: AppEvent) => void): () => void;
}

/** IPC channel names; every API method maps to `whimwatch:<method>`. */
export const API_METHODS = [
  'getSnapshot',
  'detectModsDirs',
  'chooseDirectory',
  'setDirs',
  'updateSettings',
  'startCheck',
  'cancelCheck',
  'dismiss',
  'undismiss',
  'dismissAll',
  'undoSeen',
  'dismissFirstCheckNotice',
  'markSeen',
  'dismissGameWarning',
  'dismissAppUpdate',
  'checkAppUpdate',
  'addLink',
  'rejectLink',
  'undoRejectLink',
  'unrejectLink',
  'setCreatorSite',
  'setFileIgnored',
  'openExternal',
  'showLinkMenu',
  'openBackupFolder',
  'showFile',
  'listOtherFiles',
  'showVerification',
  'dismissVerification',
  'signIn',
  'signOut',
  'planUpdate',
  'applyUpdate',
  'undoInstall',
  'undoBatch',
  'isGameRunning',
  'isWindowFocused',
  'previewDirs',
  'updateAll',
  'stopUpdateAll',
  'cancelUpdate',
  'cancelUpdateAll',
  'getStorage',
  'getDiagnostics',
  'copyDiagnostics',
  'saveDiagnostics',
  'getLicenses',
  'removeAllData',
  'clearBackups',
  'clearCaches',
] as const satisfies readonly Exclude<keyof WhimWatchApi, 'onEvent'>[];

export const EVENT_CHANNEL = 'whimwatch:event';
