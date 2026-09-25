# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/).

## [0.3.1] - 2026-09-25

### Added

- WhimWatch is available in Traditional Chinese, and chosen automatically on systems set to Chinese in Taiwan, Hong Kong or Macau.

## [0.3.0] - 2026-09-25

### Added

- WhimWatch is available in Italian. It follows your system's language, and Settings → General → Language picks one yourself. Diagnostics stay in English, so bug reports can be read.
- WhimWatch is available in Spanish.

### Fixed

- The explanation of why "Continue with Google" can't work inside WhimWatch now appears whatever language Google's page is in, not only English.
- "Released … ago" and similar counts whole years, months and days gone by. A release from 6 years and 7 months ago now says "6 years ago", not "7 years ago".

## [0.2.5] - 2026-09-24

### Added

- Pages you removed from a creator, with "Not this creator's page" or "Not interested" in a pack, are listed under "N pages hidden" in the creator's details, and each can be shown again. Before, the temporary "Undo" in the pop-up was the only way to reverse these.

### Changed

- LoversLab pages are dated by their files, not by the page. Editing a page, or adding a new pack to it, no longer makes your pack on it look out of date. A newer version of your own file under a new name still counts as an update. For such pages WhimWatch reads the page's list of files on each check, one extra request.
- A new pack added to a LoversLab page you follow is shown under "New on a page of theirs". "Get it" downloads only that file, "Not interested" hides it ("Show it again", in the creator's details, brings it back), and updating your pack from that page leaves it out.
- Files you leave unticked in an update start unticked the next time an update brings them, with a note saying so. "Update all" leaves them out and says how many it left out. New files an update adds still start ticked.
- Updating from a LoversLab page no longer downloads files you already have before being able to test if they are the same. WhimWatch reads the page's list of files first and only downloads the ones that are newer than yours. If none are, it says you're up to date right away, and "Download and compare anyway" is there if your file dates can't be trusted. Update all leaves it for you to decide.

### Fixed

- Page titles written in styled Unicode letters (a name like "𝑴𝒐𝒐𝒏𝒃𝒆𝒓𝒓𝒚") are shown as plain text. Before, depending on your system, they could show as empty boxes, and they could not be searched.
- A page you add to a creator is read straight away, so the creator's row updates without waiting for the next check, even while a check is running. Before, a creator with no page stayed under "Need a look" with nothing to show the page had been added. An added page that hasn't been read yet is listed in the creator's details.

## [0.2.4] - 2026-09-23

### Changed

- Update buttons greyed out during a check now say why: they are available when the check finishes.

### Fixed

- A creator with no download pages no longer shows under "Need a look" once every site is turned off for them.
- Signing in to LoversLab or Patreon while a check is running no longer stops the check with "Check failed: Cancelled". Signing out or clearing browsing data mid-check now only affects the page being loaded at that moment.
- When a download only adds files you don't have and your own files in it are unchanged (a creator's new Simlish edition, say), WhimWatch no longer installs it as an update. Update all leaves it alone, and the Update window says it's probably a new pack and lets you install the new files or mark it as seen.
- Long file names in the update window's notices wrap instead of running off the side.

## [0.2.3] - 2026-09-23

### Fixed

- Mark as seen, turning a site off for a creator, and removing a page now show immediately while a check is running (before, the row stayed as it was until the check finished)
- Changes made while a check is running now persist for creators the check hasn't reached yet. A removed page no longer comes back when the check ends, its Undo works even once the check has moved past that creator, and a page marked as seen stays hidden.
- A site turned off while a check is running is no longer contacted for the rest of that check.
- Undoing "Mark as seen" for one page, from History or with "Undo mark as seen", shows that update again straight away (before, it would stay hidden until the next check)

## [0.2.2] - 2026-09-19

### Changed

- WhimWatch now asks GitHub for the latest version every time it starts, rather than once a day. If
  you restart after seeing that an update is out, you no longer get the same notice from a day-old
  answer.

### Fixed

- **Mark as seen** now sticks to the pack you marked. Clothing and body packs often carry no creator
  details inside the file, so WhimWatch couldn't date them individually — and marking one of them
  quietly marked the whole creator instead. One date covered every pack of theirs, and their next
  post outran it, so the same prompt kept coming back. Each pack is now marked on its own.

## [0.2.1] - 2026-09-19

### Changed

- Privacy fix: Diagnostics no longer include your Mods folder paths, only their shape — "the default
  Documents location, another drive or folder". Hiding your home folder wasn't enough on its own: a
  folder on another drive, a network share, a mounted Windows drive, or a work OneDrive could potentially have a name
  in it. Bug reports still say the part that helps with diagnosis.

### Fixed

- **Add a download page** now takes an address pasted straight from your browser. Browsers hide the
  `https://`, so what you copy often arrives without it — and WhimWatch used to turn those away as
  unsupported. It also now says what's wrong with the link you gave ("that's a LoversLab page, but
  not a file page") instead of only listing what it accepts.
- Adding a download page now refuses an address that only looks like a supported site. A link such
  as `javascript://wicked.cc/…` parsed as a wicked.cc page and was accepted, because only the host
  was ever checked. Present since 0.1.0; nothing is known to have used it.
- WhimWatch now closes gracefully on quit. After a check had run, closing the window could leave it running with
  nothing on screen — and because it still held the single-instance lock, opening WhimWatch again
  did nothing until the old one was ended in Task Manager. The hidden windows it uses to read sites
  were keeping it alive.

## [0.2.0] - 2026-09-18

### Added

- Settings → Help & about now has **Check for updates** next to the version, for asking right away
  instead of waiting for the once-a-day check. It answers either way: the version it found, or that
  you're on the latest one and when it looked. It works even with *Tell me when a new WhimWatch
  version is out* switched off — that setting still governs the automatic check.
- A pack you don't have is no longer treated as an update. Creators on wicked.cc post a page per
  pack, and the newest one is often something you never had — WhimWatch said *Update ready*, and
  clicking Update downloaded it only to find nothing to install. Those pages are now told apart from
  the ones matching your files, and left out of the creator's status, of **Update all**, and of
  automatic installs.
- Each creator now lists their packs you don't have, with **Get it** to download one, a link to open
  the page, and *Not interested* to never hear about one again. Turn it off with **Show packs you
  don't have** in Settings → General to keep WhimWatch to the packs you already have.
- WhimWatch only says a page is one you don't have when nothing of yours is named after it. Where
  it can't tell, the page is still checked for updates exactly as before.
- History calls one of these **Added** rather than "Updated", since nothing of yours was replaced.
- A long list of files that aren't in a download is folded away in the update window instead of
  pushing everything else off screen.

### Changed

- The "a new WhimWatch is out" notice in the header now stands out from the grey status labels
  around it, and says plainly that your copy is behind: **Update WhimWatch to 0.2.0**, rather than
  "WhimWatch 0.2.0 is out". Hovering it shows which version you're on.

### Fixed

- Creators now get credit for their clothing, body and object packages, not just their animations.
  Those files carry no author information inside them, so WhimWatch went by file name as well: a
  creator known from an animation pack also gets the files named after them. On the developer's own
  install that moved 102 files out of "other files" and onto the creators who made them — one creator
  went from 4 files to 20 — which is what WhimWatch compares against a download page's date, so
  fewer creators now look out of date when they aren't.
- Updates for those creators install over the file you already have instead of dropping a second
  copy in your Mods folder.
- A download page whose version is a long line of text — LoversLab hands back things like
  "80_updated_1016_anims - 03/19/25" — no longer paints over the site's name and page title. The
  version now sits on its own line and is shortened to fit; the date and the page stay readable.
- The top bar no longer runs off the edge when the window is narrow. Search folds down to just its
  magnifier below 960px wide — click it or press `/` to open the box, and it stays open while you
  have a search in progress — and below 800px History keeps its icon without the word. Nothing is
  removed, and the notice about a new WhimWatch version keeps its full wording at every size.
- An update to one of a creator's packs no longer goes unnoticed because you installed a different
  pack of theirs more recently. WhimWatch used to compare a creator's newest page against your
  newest file from them, so getting one pack could hide a pending update to another — sometimes for
  years. Where a page names the pack it's for, it's now compared against your files from that pack.
- Clicking **Update** downloads the pack that's actually behind, instead of the creator's newest
  page (which was often one you already had, so the download turned out to contain nothing).
- A row now says **Update posted 3 days ago** rather than "New release 3 days ago", since what
  needs updating is often an older pack you never caught up with, and *Most out of date* sorting
  measures how far behind the furthest-behind pack is.
- The portable Windows build no longer fails silently forever once its unpacked copy is damaged.
  It used to unpack into one folder shared by every launch; if a file was held open while it
  unpacked, that folder stayed incomplete and every later launch started nothing at all — no
  window, no error, nothing in the log. Each launch now unpacks into its own folder. The README
  says what to do if you hit this on 0.1.1 or earlier.
- Installing an update now clears it straight away. It used to keep saying *Update ready* for that
  pack until the next full check, and clicking Update again just re-downloaded the same files.
- Marking one pack as seen no longer hides a different pack of the same creator that is genuinely
  behind — including when **Update all** marks one automatically after finding the files identical.
- The row's Update button and the download now agree on which page to fetch, so a creator can no
  longer offer *Update* and then quietly do nothing.
- Settings says **Out of date** when a new WhimWatch is out and you hid the header notice, instead
  of "You're on the latest version".
- After a download turns out to contain nothing new, the "newer elsewhere" note only points at
  packs that are themselves behind — never at one you own and are up to date on.
- The Windows installer now tells you it finished. It used to close in silence whether or not
  anything had worked, because a one-click installer has no finish page at all. There's now a last
  page with **Run WhimWatch now** (ticked) and **Create a desktop shortcut** (not ticked, so nothing
  appears on a shared computer's desktop unless you ask). There's still nothing to fill in: it
  installs, you click Finish.
- It also always creates the Start menu entry. Reinstalling used to create no shortcut at all if
  you'd ever deleted the old one, which left a successful install with nothing to show for itself —
  and cost you WhimWatch's update notifications, which Windows ties to that entry.
- Uninstalling removes a desktop shortcut you asked for, and still offers to remove your settings,
  sign-ins and backups.

## [0.1.1] - 2026-09-17

### Fixed

- A Cloudflare check on Patreon or LoversLab no longer repeats page after page. WhimWatch leaves that
  site alone until you've passed the check once, so the window you're working in isn't replaced by the
  next creator's challenge, and the rest of the check finishes instead of waiting out a timeout per page.
- The *Verify* window opens the site's own front page rather than the creator page the check stopped on,
  closes itself once you're through, and a check that is still running carries on with that site.
- Human checks that don't say "Just a moment" are recognized too, so a challenge is no longer read as a
  creator page with nothing on it.
- Signing in to Patreon with an account made through Google no longer dead-ends in silence. Google won't
  sign anyone in from inside an app, and Patreon turns down the email box for such an account too, so
  WhimWatch now says so as soon as a sign-in reaches Google and points at the way through: sign in to the
  site in your browser, add a password in your account settings, and use that here.
- Sign-in pop-ups ("Continue with Google" and the like) open as real windows of the site's own session
  again, instead of being loaded over the page that opened them, which left that page waiting forever.
- An opened creator no longer keeps the result of an update that has finished. "Already up to date with
  wicked.cc" used to stay under a creator still marked *Update ready*, which read as a contradiction
  even though both were true: your files match what that page offers, and the page is still dated
  later than your files.
- When the newer page is on the same site you just downloaded from, it's called "another wicked.cc
  page" rather than "wicked.cc", which was pointing you back at the site you were already looking at.
- An update with nothing to install now gives you the verdict rather than the arithmetic: "Nothing to
  install — you already have this. The download here is identical to your files, so there's no update
  after all." It used to compare the page's date with your files' dates and leave you to work out
  whether you were missing something.
- When a *different* page of that creator's is the newer one, it's named, with buttons to download
  that one instead, open it, or drop it from the creator so it stops counting — and marking as seen
  hides that page too, rather than saying it's dealt with and leaving *Update ready* in place.
- *Download from* names each page, not the site it's on. A creator with a dozen wicked.cc pages used
  to offer a dozen choices all called "wicked.cc", with only the date to tell them apart. Page names
  stay hidden when "Hide page titles" is on.

## [0.1.0] - 2026-09-16

First public version.

### Added

- Scans Mods folders and identifies WickedWhims creator packages by the creator named inside each file.
- Finds creators' pages through the WickedWhims download page, wicked.cc, LoversLab and Patreon, plus a
  community catalog and links you add yourself.
- Checks for updates when the app opens or on demand, with cancel. Shows WickedWhims' latest version and
  supported game versions.
- Warns when mods or script mods are turned off in the game, or when an EA patch is newer than WickedWhims supports.
- One-click and "Update all" updates, choosing the newest source you can download from (most files on
  ties), with a preview, per-file choices, backups and undo.
- Detects downloads identical to what's installed ("Already up to date"), and "Mark all as seen". When another
  site was updated later, it's named, with a button to open it.
- Sites to check: turn off wicked.cc, LoversLab or Patreon for every creator (Settings → General) or for one creator
  (their row), and WhimWatch doesn't contact it for them or show its updates. Choices are kept between runs, and
  creators only found on a turned-off site show as "Not checked" instead of needing a look.
- Removing a creator's Patreon page ("Not this creator's page") also covers its other address forms, so it doesn't
  come back as `/cw/name` or `/c/name`.
- Optional sign-in to LoversLab and Patreon on the sites' own pages; cookies are encrypted at rest.
- Patreon downloads come from files attached to the release post, from a post it links to by the same creator (for
  creators who keep one "download files" post and replace its file each release), or from a single Mega or Google
  Drive link, including in posts written with Patreon's newer editor.
- Privacy: browsing data from the built-in site browser is wiped on exit, or never written to disk when
  sign-ins aren't kept; checking windows load nothing from third parties; links can open in a private
  window; notifications don't name creators unless enabled; a "discreet settings" preset.
- Storage settings: backup retention, deleting backups, clearing downloads, browsing data and the log, and
  removing all WhimWatch data (the Windows uninstaller also offers this).
- Notice when a newer WhimWatch release is available (can be turned off).
- Diagnostics for bug reports, previewed before copying or saving. Logs never contain page addresses.
- History: every update and "mark as seen", with undo.
- Privacy levels (Standard, Discreet, Custom), a privacy screen that blurs the window and keeps it out of
  screenshots, an opt-in quick-hide shortcut, and hidden post titles.
- Theme setting (dark, light or system).
- Help menu and Settings → Help & about: the guide, bug reports (with a diagnostics preview), site problems, creator
  links, feature ideas and private security reports on GitHub; Support WhimWatch (Buy Me a Coffee); and Licences, with the full licence text of everything WhimWatch includes (generated at build time;
  the build fails on a dependency licence nobody has reviewed).
- Continuous integration on every pull request and push to `main` (tests on Windows, macOS and Linux, plus a
  packaging check), and tagged releases that build Windows, macOS and Linux installers, a source archive and
  checksums into a draft release.
- Linux `.rpm` package; the Windows installer is now one click and per-user, without a desktop shortcut.

### Changed

- WhimWatch checks for updates only when you click Check now. Checking automatically when it opens is an option
  (in setup and Settings → General), off by default.
- New interface: status counts that filter the list, a "safe to play?" card that shows your game version next to
  the one WickedWhims supports, one Update button per row, full-page Settings with sections, a three-step setup, and
  a dark-first look with bundled Manrope and JetBrains Mono fonts.
- The list keeps its last results while a check runs, and rows update in place.
- Update preview: a one-line summary, colour-coded file changes, and Install disabled while The Sims 4 is open.
- Update all: select all or none, runs in the background with taskbar progress, and ends with a summary and Undo all.
- In-app confirmations, toasts with undo, keyboard support (Escape, focus kept in dialogs, `/` to search, Ctrl+R to
  check), and spelled-out times and numbers.
- The package description no longer names WickedWhims, since it shows in Start menu shortcuts and app lists.

### Fixed

- Installers no longer include the project's source code, tests and documents, only the built app.
- Turning on Quick hide now switches the privacy level to Custom, like every other privacy setting.
