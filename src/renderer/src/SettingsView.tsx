import {
  ArrowLeft,
  BookOpen,
  Bug,
  CodeXml,
  Coffee,
  Database,
  Download,
  FolderOpen,
  FolderPlus,
  Info,
  Lightbulb,
  MessageSquareWarning,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  User,
  UserSearch,
  Wrench,
  X,
} from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useEffect, useState } from 'react';
import type { AppSnapshot, StorageInfo } from '../../shared/api';
import { docsUrl, repoUrl, securityReportUrl, SUPPORT_URL, translateUrl } from '../../shared/config';
import { getLocale, type LanguageSetting, LOCALE_IDS, LOCALE_INFO, t } from '../../shared/i18n';
import { openIssueForm, type ReportForm } from './Feedback';
import { type PrivacyLevel, privacyLevel, privacyLevelPatch } from '../../shared/privacy';
import { type AppSettings, UPDATE_SITES } from '../../shared/types';
import { Dialog, useConfirm } from './dialog';
import { DuplicatesDialog } from './DuplicatesDialog';
import { acceleratorFromKey, acceleratorKeys, formatBytes, SOURCE_LABEL, timeAgo } from './format';
import { useToast } from './toast';
import { api, type AppModel } from './useApp';
import { rich } from './rich';
import { useSiteToggle } from './useSiteToggle';
import { Banner, Button, IconButton, Kbd, Segmented, SettingRow, ToggleRow } from './ui';

export type SettingsSection = 'general' | 'privacy' | 'accounts' | 'updates' | 'storage' | 'tools' | 'about';

const SECTIONS: { id: SettingsSection; icon: typeof Info }[] = [
  { id: 'general', icon: SlidersHorizontal },
  { id: 'privacy', icon: ShieldCheck },
  { id: 'accounts', icon: User },
  { id: 'updates', icon: Download },
  { id: 'storage', icon: Database },
  { id: 'tools', icon: Wrench },
  { id: 'about', icon: Info },
];

export function SettingsView({
  app,
  section,
  onSection,
  onBack,
  onReport,
}: {
  app: AppModel;
  section: SettingsSection;
  onSection: (section: SettingsSection) => void;
  onBack: () => void;
  onReport: (form: ReportForm) => void;
}) {
  const snapshot = app.snapshot!;
  const set = (patch: Partial<AppSettings>): Promise<AppSnapshot | undefined> => app.run(() => api.updateSettings(patch));
  const m = t().settings;

  const onNavKey = (e: KeyboardEvent, index: number): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const next = SECTIONS[(index + (e.key === 'ArrowDown' ? 1 : -1) + SECTIONS.length) % SECTIONS.length]!;
    onSection(next.id);
    document.getElementById(`settings-nav-${next.id}`)?.focus();
  };

  return (
    <div className="settings-page">
      <nav className="settings-nav" aria-label={t().common.settings}>
        <button type="button" className="back-link" onClick={onBack}>
          <ArrowLeft size={16} aria-hidden="true" /> {m.back}
        </button>
        <h1>{t().common.settings}</h1>
        <ul>
          {SECTIONS.map((s, i) => {
            const IconComponent = s.icon;
            return (
              <li key={s.id}>
                <button
                  id={`settings-nav-${s.id}`}
                  type="button"
                  className={section === s.id ? 'active' : ''}
                  aria-current={section === s.id ? 'page' : undefined}
                  onClick={() => onSection(s.id)}
                  onKeyDown={(e) => onNavKey(e, i)}
                >
                  <IconComponent size={18} aria-hidden="true" /> {m.section[s.id]}
                </button>
              </li>
            );
          })}
        </ul>
        <span className="spacer" />
        <span className="faint small">{m.version(snapshot.appVersion)}</span>
      </nav>

      <main className="settings-content" id="main">
        {app.error && (
          <Banner tone="error" onClose={() => app.setError(undefined)}>
            {app.error}
          </Banner>
        )}
        {section === 'general' && <General snapshot={snapshot} app={app} set={set} />}
        {section === 'privacy' && <Privacy snapshot={snapshot} set={set} />}
        {section === 'accounts' && <Accounts snapshot={snapshot} app={app} onPrivacy={() => onSection('privacy')} />}
        {section === 'updates' && <Updates snapshot={snapshot} app={app} set={set} />}
        {section === 'storage' && <Storage snapshot={snapshot} app={app} />}
        {section === 'tools' && <Tools app={app} />}
        {section === 'about' && <About app={app} onReport={onReport} />}
      </main>
    </div>
  );
}

type Setter = (patch: Partial<AppSettings>) => Promise<AppSnapshot | undefined>;

const CHECK_OPTIONS = [
  { value: 'manual', label: 'manual', patch: { checkOnLaunch: false } },
  { value: 'always', label: 'always', patch: { checkOnLaunch: true, recheckAfterMinutes: 0 } },
  { value: '60', label: 'hour', patch: { checkOnLaunch: true, recheckAfterMinutes: 60 } },
  { value: '360', label: 'sixHours', patch: { checkOnLaunch: true, recheckAfterMinutes: 360 } },
  { value: '1440', label: 'day', patch: { checkOnLaunch: true, recheckAfterMinutes: 1440 } },
] as const;

function checkValue(s: AppSettings): string {
  if (!s.checkOnLaunch) return 'manual';
  if (s.recheckAfterMinutes === 0) return 'always';
  return CHECK_OPTIONS.some((o) => o.value === String(s.recheckAfterMinutes)) ? String(s.recheckAfterMinutes) : '60';
}

function PageHead({ title, text }: { title: string; text?: string }) {
  return (
    <header className="settings-head">
      <h2>{title}</h2>
      {text && <p className="muted">{text}</p>}
    </header>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="settings-group">
      <h3 className="section-label">{label}</h3>
      <div className="card settings-card">{children}</div>
    </section>
  );
}

function General({ snapshot, app, set }: { snapshot: AppSnapshot; app: AppModel; set: Setter }) {
  const { settings, dirs } = snapshot;
  const toggleSite = useSiteToggle(app);
  const m = t().settings;
  const addDir = async (): Promise<void> => {
    const dir = await app.run(() => api.chooseDirectory());
    if (dir) await app.run(() => api.setDirs([...dirs, dir]));
  };
  return (
    <>
      <PageHead title={m.section.general} />
      <Group label={m.modsFolders}>
        {dirs.map((dir) => (
          <div key={dir} className="setting-row">
            <code className="grow dir-path">{dir}</code>
            <IconButton label={m.openFolder} icon={FolderOpen} size={16} onClick={() => app.run(() => api.showFile(dir))} />
            <IconButton label={m.stopWatching(dir)} icon={X} size={16} onClick={() => app.run(() => api.setDirs(dirs.filter((d) => d !== dir)))} disabled={dirs.length === 1} />
          </div>
        ))}
        <div className="setting-row">
          <span className="setting-hint grow">{m.modsFoldersHint}</span>
          <Button size="sm" icon={FolderPlus} onClick={addDir}>
            {m.addFolder}
          </Button>
        </div>
      </Group>
      <Group label={m.appearance}>
        <SettingRow title={m.theme}>
          <Segmented<AppSettings['theme']>
            label={m.theme}
            value={settings.theme}
            onChange={(theme) => set({ theme })}
            options={[
              { value: 'dark', label: m.dark },
              { value: 'light', label: m.light },
              { value: 'system', label: m.system },
            ]}
          />
        </SettingRow>
        <SettingRow
          title={m.language}
          hint={
            <>
              {m.languageHint}{' '}
              <button type="button" className="link-btn accent" onClick={() => app.run(() => api.openExternal(translateUrl()))}>
                {m.helpTranslate}
              </button>
            </>
          }
        >
          {/* Each language by its own name, as someone looking for theirs will read it. */}
          <select aria-label={m.language} value={settings.language} onChange={(e) => set({ language: e.target.value as LanguageSetting })}>
            <option value="system">{m.languageSystem(LOCALE_INFO[snapshot.systemLocale].name)}</option>
            {LOCALE_IDS.map((id) => (
              <option key={id} value={id} lang={LOCALE_INFO[id].intl}>
                {LOCALE_INFO[id].name}
              </option>
            ))}
          </select>
        </SettingRow>
      </Group>
      <Group label={m.checking}>
        <SettingRow title={m.checkForUpdates} hint={m.checkForUpdatesHint}>
          <select value={checkValue(settings)} onChange={(e) => set(CHECK_OPTIONS.find((o) => o.value === e.target.value)!.patch)}>
            {CHECK_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {m.checkWhen[o.label]}
              </option>
            ))}
          </select>
        </SettingRow>
        <ToggleRow title={m.appUpdates} hint={m.appUpdatesHint} checked={settings.checkAppUpdates} onChange={(v) => set({ checkAppUpdates: v })} />
        <ToggleRow title={m.newPacks} hint={m.newPacksHint} checked={settings.showNewPacks} onChange={(v) => set({ showNewPacks: v })} />
      </Group>
      <Group label={m.sitesToCheck}>
        <div className="setting-row">
          <span className="setting-hint grow">{m.sitesHint}</span>
        </div>
        {UPDATE_SITES.map((site) => (
          <ToggleRow
            key={site}
            title={SOURCE_LABEL[site]}
            hint={m.siteHint[site]}
            checked={!settings.mutedSources.includes(site)}
            onChange={(on) => void toggleSite(site, on)}
          />
        ))}
      </Group>
    </>
  );
}

function Privacy({ snapshot, set }: { snapshot: AppSnapshot; set: Setter }) {
  const { settings } = snapshot;
  const hasBrowser = snapshot.browsers.length > 0;
  const level = privacyLevel(settings, hasBrowser);
  const memoryOnly = settings.clearBrowsingDataOnExit && settings.forgetSignInsOnExit;
  const windows = snapshot.platform === 'win32';
  const m = t().settings;

  return (
    <>
      <PageHead title={m.section.privacy} text={m.privacyIntro} />
      <section className="settings-group">
        <h3 className="section-label">{m.privacyLevel}</h3>
        <Segmented<PrivacyLevel>
          label={m.privacyLevel}
          className="wide"
          value={level}
          onChange={(v) => v !== 'custom' && set(privacyLevelPatch(v, hasBrowser))}
          options={[
            { value: 'standard', label: m.standard },
            { value: 'discreet', label: m.discreet },
            { value: 'custom', label: m.custom, disabled: level !== 'custom' },
          ]}
        />
        <p className="muted small level-text">{m.levelText[level]}</p>
      </section>

      <Group label={m.onScreen}>
        <ToggleRow
          title={m.privacyScreen}
          hint={m.privacyScreenHint(snapshot.platform !== 'linux')}
          checked={settings.privacyScreen}
          onChange={(v) => set({ privacyScreen: v })}
        />
        <QuickHide snapshot={snapshot} set={set} />
        <ToggleRow title={m.hideTitles} hint={m.hideTitlesHint} checked={settings.hidePageTitles} onChange={(v) => set({ hidePageTitles: v })} />
      </Group>

      <Group label={m.notifications}>
        <ToggleRow
          title={m.notificationNames}
          hint={m.notificationNamesHint(windows)}
          checked={settings.notificationNames}
          onChange={(v) => set({ notificationNames: v })}
        />
      </Group>

      <Group label={m.linksAndSignIns}>
        <ToggleRow
          title={m.privateLinks}
          hint={hasBrowser ? m.privateLinksHint : m.noPrivateBrowser}
          checked={settings.privateLinks}
          onChange={(v) => set({ privateLinks: v })}
          disabled={!hasBrowser}
        />
        {hasBrowser && snapshot.browsers.length > 1 && settings.privateLinks && (
          <SettingRow title={m.privateBrowser} indent>
            <select value={settings.privateBrowser ?? snapshot.browsers[0]!.id} onChange={(e) => set({ privateBrowser: e.target.value })}>
              {snapshot.browsers.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                  {b.isDefault ? t().common.defaultBrowser : ''}
                </option>
              ))}
            </select>
          </SettingRow>
        )}
        <ToggleRow
          title={m.clearOnExit}
          hint={m.clearOnExitHint}
          checked={settings.clearBrowsingDataOnExit}
          onChange={(v) => set({ clearBrowsingDataOnExit: v })}
        />
        <ToggleRow
          indent
          title={m.forgetSignIns}
          disabled={!settings.clearBrowsingDataOnExit}
          hint={
            memoryOnly && !snapshot.sessionsInMemory
              ? m.forgetFromNextStart
              : !memoryOnly && snapshot.sessionsInMemory
                ? m.forgetUntilRestart
                : m.forgetOn
          }
          checked={settings.forgetSignInsOnExit}
          onChange={(v) => set({ forgetSignInsOnExit: v })}
        />
      </Group>
    </>
  );
}

function QuickHide({ snapshot, set }: { snapshot: AppSnapshot; set: Setter }) {
  const { settings } = snapshot;
  const [capturing, setCapturing] = useState(false);
  const [hint, setHint] = useState<string>();
  const keys = acceleratorKeys(settings.quickHideShortcut, snapshot.platform);
  const m = t().settings;

  const onKey = async (e: KeyboardEvent): Promise<void> => {
    if (!capturing) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') {
      setCapturing(false);
      setHint(undefined);
      return;
    }
    const accelerator = acceleratorFromKey(e, snapshot.platform);
    if (!accelerator) {
      setHint(m.quickHideInvalid);
      return;
    }
    setCapturing(false);
    setHint(undefined);
    await set({ quickHideShortcut: accelerator, quickHide: true });
  };

  return (
    <SettingRow
      title={m.quickHide}
      hint={capturing ? <span className="accent-text">{hint ?? m.quickHidePress}</span> : m.quickHideHint}
    >
      <span className="shortcut" aria-label={m.shortcut(keys.join(' '))}>
        {keys.map((k) => (
          <Kbd key={k}>{k}</Kbd>
        ))}
      </span>
      <Button size="sm" onClick={() => setCapturing(true)} onKeyDown={onKey} onBlur={() => setCapturing(false)} aria-live="polite">
        {capturing ? m.pressKeys : t().common.change}
      </Button>
      <span className="switch-wrap">
        <button
          type="button"
          role="switch"
          aria-checked={settings.quickHide}
          aria-label={m.quickHide}
          className={`switch ${settings.quickHide ? 'on' : ''}`}
          onClick={() => set({ quickHide: !settings.quickHide })}
        />
      </span>
    </SettingRow>
  );
}

function Accounts({ snapshot, app, onPrivacy }: { snapshot: AppSnapshot; app: AppModel; onPrivacy: () => void }) {
  const m = t().settings;
  return (
    <>
      <PageHead title={m.section.accounts} text={m.accountsIntro} />
      <Group label={m.sites}>
        {snapshot.accounts.map((a) => (
          <div key={a.site} className="setting-row">
            <span className={`dot ${a.signedIn ? 'on' : ''}`} aria-hidden="true" />
            <div className="setting-text">
              <span className="setting-title">{a.label}</span>
              <span className="setting-hint">
                {a.signedIn ? m.signedIn : m.notSignedIn}
                {snapshot.settings.mutedSources.includes(a.site) && m.siteTurnedOff}
              </span>
            </div>
            <span className="spacer" />
            {a.signedIn ? (
              <Button size="sm" onClick={() => app.run(() => api.signOut(a.site))}>
                {m.signOut}
              </Button>
            ) : (
              <Button size="sm" onClick={() => app.run(() => api.signIn(a.site))}>
                {m.signIn}
              </Button>
            )}
          </div>
        ))}
      </Group>
      {snapshot.weakCookieStorage && !snapshot.sessionsInMemory && (
        <Banner
          tone="warn"
          title={m.weakStorageTitle}
          actions={
            <Button size="sm" onClick={onPrivacy}>
              {m.privacySettings}
            </Button>
          }
        >
          {m.weakStorage}
        </Banner>
      )}
      <Banner tone="info" title={m.howSignInWorksTitle}>
        {m.howSignInWorks}
      </Banner>
      <Banner tone="info" title={m.googleTitle}>
        {m.google}
      </Banner>
    </>
  );
}

/** Days to keep backups for; 0 is until they're deleted by hand. */
const KEEP_OPTIONS = [7, 30, 90, 0];

function Updates({ snapshot, app, set }: { snapshot: AppSnapshot; app: AppModel; set: Setter }) {
  const { settings } = snapshot;
  const m = t().settings;
  return (
    <>
      <PageHead title={m.section.updates} text={m.updatesIntro} />
      <Group label={m.installing}>
        <ToggleRow title={m.autoInstall} hint={m.autoInstallHint} checked={settings.autoInstall} onChange={(v) => set({ autoInstall: v })} />
      </Group>
      <Group label={m.backups}>
        <SettingRow title={m.keepBackups} hint={m.keepBackupsHint}>
          <select value={settings.keepBackupsDays} onChange={(e) => set({ keepBackupsDays: Number(e.target.value) })}>
            {KEEP_OPTIONS.map((days) => (
              <option key={days} value={days}>
                {days ? m.keepFor(days) : m.keepUntilDeleted}
              </option>
            ))}
          </select>
        </SettingRow>
        <SettingRow title={m.backupFolder} hint={rich(m.backupFolderHint, { path: <code>{snapshot.backupRoot}</code> })}>
          <Button size="sm" icon={FolderOpen} onClick={() => app.run(() => api.openBackupFolder())}>
            {m.open}
          </Button>
        </SettingRow>
      </Group>
    </>
  );
}

function Storage({ snapshot, app }: { snapshot: AppSnapshot; app: AppModel }) {
  const confirm = useConfirm();
  const toast = useToast();
  const [storage, setStorage] = useState<StorageInfo>();
  const m = t().settings;

  useEffect(() => {
    api.getStorage().then(setStorage, () => undefined);
  }, [snapshot.installs]);

  const deleteBackups = async (): Promise<void> => {
    const ok = await confirm({
      title: m.deleteBackupsTitle,
      body: m.deleteBackupsBody,
      confirmLabel: m.deleteBackups,
      danger: true,
    });
    if (!ok) return;
    if (await app.run(() => api.clearBackups())) {
      setStorage(await api.getStorage());
      toast({ text: m.backupsDeleted });
    }
  };

  const clearCaches = async (): Promise<void> => {
    const next = await app.run(() => api.clearCaches());
    if (next) {
      setStorage(next);
      toast({ text: m.cachesCleared });
    }
  };

  return (
    <>
      <PageHead title={m.section.storage} text={m.storageIntro} />
      <Group label={m.spaceUsed}>
        <SettingRow title={m.backups} hint={storage ? formatBytes(storage.backups) : '…'}>
          <Button size="sm" icon={Trash2} onClick={deleteBackups} disabled={!storage?.backups}>
            {m.deleteAll}
          </Button>
        </SettingRow>
        <SettingRow title={m.caches} hint={m.cachesHint(storage ? formatBytes(storage.caches) : '…')}>
          <Button size="sm" onClick={clearCaches}>
            {m.clear}
          </Button>
        </SettingRow>
      </Group>
      <Group label={m.removeEverything}>
        <SettingRow title={m.removeAll} hint={m.removeAllHint}>
          <Button size="sm" variant="danger" onClick={() => app.run(() => api.removeAllData())}>
            {m.removeAllButton}
          </Button>
        </SettingRow>
      </Group>
    </>
  );
}

/** Housekeeping for the Mods folders, run here and only when asked. */
function Tools({ app }: { app: AppModel }) {
  const [duplicates, setDuplicates] = useState(false);
  const m = t().settings;
  // Reading an online-only OneDrive file downloads it: said before the search, not after. The same
  // test as the diagnostics' "OneDrive-redirected" (main/modsdir.ts).
  const oneDrive = app.snapshot?.dirs.some((d) => /onedrive/i.test(d));
  return (
    <>
      <PageHead title={m.section.tools} text={m.toolsIntro} />
      <Group label={m.cleanUp}>
        <SettingRow title={m.duplicateFiles} hint={oneDrive ? `${m.duplicateFilesHint} ${m.duplicatesOneDrive}` : m.duplicateFilesHint}>
          <Button size="sm" onClick={() => setDuplicates(true)} disabled={!app.snapshot?.dirs.length}>
            {m.findDuplicates}
          </Button>
        </SettingRow>
      </Group>
      {duplicates && <DuplicatesDialog app={app} onClose={() => setDuplicates(false)} />}
    </>
  );
}

/**
 * The version, and a way to ask about a newer one now. An answer either way:
 * a button that shows nothing when you're up to date reads as broken.
 */
function VersionRow({ app }: { app: AppModel }) {
  const snapshot = app.snapshot!;
  const [checking, setChecking] = useState(false);
  const update = snapshot.appUpdate;

  const check = async (): Promise<void> => {
    setChecking(true);
    await app.run(() => api.checkAppUpdate());
    setChecking(false);
  };

  const m = t().settings;
  const hint = checking
    ? m.askingGitHub
    : update
      ? m.outOfDate(update.version, Boolean(update.hidden))
      : snapshot.appUpdateCheckedAt !== undefined
        ? m.latest(timeAgo(snapshot.appUpdateCheckedAt))
        : m.notCheckedYet;

  return (
    <SettingRow title={m.versionTitle(snapshot.appVersion)} hint={hint}>
      {update ? (
        <Button size="sm" variant="primary" icon={Download} onClick={() => app.run(() => api.openExternal(update.url))}>
          {m.updateTo(update.version)}
        </Button>
      ) : (
        <Button size="sm" icon={RefreshCw} onClick={check} disabled={checking}>
          {checking ? m.checkingEllipsis : m.checkForUpdates}
        </Button>
      )}
      <Button size="sm" icon={CodeXml} onClick={() => app.run(() => api.openExternal(repoUrl()))}>
        {m.sourceCode}
      </Button>
    </SettingRow>
  );
}

function About({ app, onReport }: { app: AppModel; onReport: (form: ReportForm) => void }) {
  const [diagnostics, setDiagnostics] = useState<string>();
  const [licenses, setLicenses] = useState<string>();
  const m = t().settings;
  return (
    <>
      <PageHead title={m.section.about} text={m.aboutIntro} />
      <Group label={m.help}>
        <SettingRow title={m.guide} hint={m.guideHint}>
          <Button size="sm" icon={BookOpen} onClick={() => app.run(() => api.openExternal(docsUrl()))}>
            {m.openGuide}
          </Button>
        </SettingRow>
      </Group>
      <Group label={m.feedback}>
        <SettingRow title={m.reportBug} hint={m.reportBugHint}>
          <Button size="sm" icon={Bug} onClick={() => onReport('bug_report')}>
            {m.reportBugButton}
          </Button>
        </SettingRow>
        <SettingRow title={m.siteStopped} hint={m.siteStoppedHint}>
          <Button size="sm" icon={MessageSquareWarning} onClick={() => onReport('site_changed')}>
            {m.reportSite}
          </Button>
        </SettingRow>
        <SettingRow title={m.wrongCreator} hint={m.wrongCreatorHint}>
          <Button size="sm" icon={UserSearch} onClick={() => openIssueForm(app, 'creator_link')}>
            {m.reportCreator}
          </Button>
        </SettingRow>
        <SettingRow title={m.suggest} hint={m.suggestHint}>
          <Button size="sm" icon={Lightbulb} onClick={() => openIssueForm(app, 'feature_request')}>
            {m.suggest}
          </Button>
        </SettingRow>
        <SettingRow title={m.security} hint={m.securityHint}>
          <Button size="sm" icon={ShieldAlert} onClick={() => app.run(() => api.openExternal(securityReportUrl()))}>
            {m.reportPrivately}
          </Button>
        </SettingRow>
      </Group>
      <Group label="WhimWatch">
        <VersionRow app={app} />
        <SettingRow title={m.support} hint={m.supportHint}>
          <Button
            size="sm"
            icon={Coffee}
            onClick={() => app.run(() => api.openExternal(SUPPORT_URL))}
            onContextMenu={(e) => {
              e.preventDefault();
              void app.run(() => api.showLinkMenu(SUPPORT_URL));
            }}
          >
            {m.coffee}
          </Button>
        </SettingRow>
        <SettingRow title={m.diagnostics} hint={m.diagnosticsHint}>
          <Button
            size="sm"
            onClick={async () => {
              const text = await app.run(() => api.getDiagnostics());
              if (text !== undefined) setDiagnostics(text);
            }}
          >
            {m.diagnosticsButton}
          </Button>
        </SettingRow>
        <SettingRow title={m.licences} hint={m.licencesHint}>
          <Button
            size="sm"
            onClick={async () => {
              const text = await app.run(() => api.getLicenses());
              if (text !== undefined) setLicenses(text);
            }}
          >
            {m.view}
          </Button>
        </SettingRow>
      </Group>
      <p className="faint small">{m.independent}</p>
      {diagnostics !== undefined && <DiagnosticsDialog text={diagnostics} app={app} onClose={() => setDiagnostics(undefined)} />}
      {licenses !== undefined && (
        <Dialog title={m.licences} subtitle={m.licencesSubtitle} onClose={() => setLicenses(undefined)} width={760}>
          {/* The licences themselves are legal texts, and stay in the language they're written in. */}
          <textarea className="diagnostics mono licenses" readOnly value={licenses} rows={22} spellCheck={false} aria-label={m.licenceTexts} lang="en" />
        </Dialog>
      )}
    </>
  );
}

/** Shows exactly what a bug report would include before it's copied or saved. */
function DiagnosticsDialog({ text, app, onClose }: { text: string; app: AppModel; onClose: () => void }) {
  const toast = useToast();
  const m = t().settings;
  return (
    <Dialog
      title={m.diagnostics}
      subtitle={m.diagnosticsSubtitle}
      onClose={onClose}
      width={720}
      footer={
        <>
          <span className="spacer" />
          <Button
            variant="quiet"
            onClick={async () => {
              if (await app.run(() => api.saveDiagnostics())) toast({ text: m.diagnosticsSaved });
            }}
          >
            {m.saveToFile}
          </Button>
          <Button
            variant="primary"
            onClick={async () => {
              await app.run(() => api.copyDiagnostics());
              toast({ text: m.diagnosticsCopied });
            }}
          >
            {m.copy}
          </Button>
        </>
      }
    >
      {getLocale() !== 'en' && <p className="muted small">{t().feedback.englishNote}</p>}
      {/* Always English, so whoever reads the report can. */}
      <textarea className="diagnostics mono" readOnly value={text} rows={16} spellCheck={false} aria-label={m.diagnosticsText} lang="en" />
    </Dialog>
  );
}
