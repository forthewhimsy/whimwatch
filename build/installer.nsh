; Included by electron-builder's NSIS installer (build/installer.nsh is picked up automatically).

; Always install for the current user, without asking.
;
; The assisted installer shows an "install for me / for everyone" page whenever perMachine is false.
; WhimWatch is per-user by design — it installs under %LOCALAPPDATA% and needs no administrator
; rights — so the page has one right answer and only adds a step. Forcing the choice here makes the
; page skip itself, leaving Install → Finish.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

; Where it's installed: the user can choose, safely.
;
; Uninstalling deletes the install folder and everything in it (the template's RMDir /r $INSTDIR).
; Its own guard only adds a WhimWatch folder when the chosen path doesn't contain "WhimWatch"
; anywhere, so choosing D:\WhimWatch stuff would install straight into it, and uninstalling would
; take the user's files with it. Here, WhimWatch always goes in a folder named WhimWatch inside the
; one chosen, unless the chosen one is itself called WhimWatch; and a WhimWatch folder that already
; holds other files can't be used unless it's a WhimWatch install (its program and its uninstaller
; both there). Program Files and the Windows folder can't either: this installer installs for the
; current user only, without administrator rights, and couldn't write there. In the window, the
; button stays greyed out for a folder that can't be used; a silent install (/S /D=…) gets the same
; rules and stops with error code 2.
;
; Once WhimWatch is installed, the folder page isn't shown: running a newer Setup updates it where it
; is (WhimWatch doesn't use electron-updater, so its --updated, which would skip the page, is never
; passed). Moving an install means uninstalling and installing again.
!ifndef BUILD_UNINSTALLER
  Var wwDir
  Var wwUsable
  Var wwPart
  Var wwFind
  Var wwName
  Var wwDirText
  Var wwDirSeen

  ; The folder page's own text, read by MUI_PAGE_DIRECTORY, so defined before electron-builder adds
  ; the page. A variable, set in .onInit for the installer's language (wwSetText). Nothing else can be
  ; attached to that page from here: the template adds the install-mode page first, and that page
  ; takes any MUI_PAGE_CUSTOMFUNCTION_* defined beforehand, so the page is handled in .onVerifyInstDir.
  !define MUI_DIRECTORYPAGE_TEXT_TOP "$wwDirText"
!endif

; The functions come in with the header, once LogicLib, FileFunc, the languages and electron-builder's
; defines are there: this file itself is read before them.
!macro customHeader
  !ifndef BUILD_UNINSTALLER
    !include FileFunc.nsh

    ; The folder page's text, in the languages WhimWatch itself speaks and English for the rest of
    ; the installer's many: a LangString would have to be written for every one of them. Short, and
    ; about any folder: MUI's text above the folder box fits about three lines.
    Function wwSetText
      StrCpy $wwDirText "WhimWatch goes in a WhimWatch folder inside the one you choose. Program Files, Windows and folders already in use can't be used."
      !ifdef LANG_SPANISH
        ${If} $LANGUAGE == ${LANG_SPANISH}
          StrCpy $wwDirText "WhimWatch se instala en una carpeta WhimWatch dentro de la que elijas. No se pueden usar Archivos de programa, Windows ni carpetas que ya estén en uso."
        ${EndIf}
      !endif
      !ifdef LANG_ITALIAN
        ${If} $LANGUAGE == ${LANG_ITALIAN}
          StrCpy $wwDirText "WhimWatch va in una cartella WhimWatch dentro quella che scegli. Non si possono usare Programmi, Windows né cartelle già in uso."
        ${EndIf}
      !endif
      !ifdef LANG_TRADCHINESE
        ${If} $LANGUAGE == ${LANG_TRADCHINESE}
          StrCpy $wwDirText "WhimWatch 會安裝在您所選資料夾內的 WhimWatch 資料夾中。無法使用 Program Files、Windows 或已在使用中的資料夾。"
        ${EndIf}
      !endif
    FunctionEnd

    ; $wwDir: the folder chosen, made into the folder WhimWatch goes in.
    Function wwFinalDir
      StrCpy $wwPart $wwDir 1 -1
      ${If} $wwPart == "\"
        StrCpy $wwDir $wwDir -1
      ${EndIf}
      ${GetFileName} $wwDir $wwPart
      ; LogicLib's == ignores case: whimwatch is WhimWatch.
      ${If} $wwPart != "${APP_FILENAME}"
        StrCpy $wwDir "$wwDir\${APP_FILENAME}"
      ${EndIf}
    FunctionEnd

    ; $wwUsable: 1 if WhimWatch can go in $wwDir (a final folder), 0 if not.
    Function wwCheckDir
      StrCpy $wwUsable 1
      !insertmacro wwUnder "$PROGRAMFILES"
      !insertmacro wwUnder "$PROGRAMFILES64"
      !insertmacro wwUnder "$WINDIR"
      ${If} $wwUsable == 1
      ${AndIf} ${FileExists} "$wwDir\*.*"
        ; A WhimWatch install is one this installer made: its program and its uninstaller. A folder
        ; with only a WhimWatch.exe in it (a renamed portable build beside someone's own files) isn't.
        ${IfNot} ${FileExists} "$wwDir\${APP_EXECUTABLE_FILENAME}"
        ${OrIfNot} ${FileExists} "$wwDir\${UNINSTALL_FILENAME}"
          ; Anything else already there can be used only while it's empty.
          FindFirst $wwFind $wwName "$wwDir\*.*"
          ${DoWhile} $wwName != ""
            ${If} $wwName != "."
            ${AndIf} $wwName != ".."
              StrCpy $wwUsable 0
              ${ExitDo}
            ${EndIf}
            FindNext $wwFind $wwName
          ${Loop}
          FindClose $wwFind
        ${EndIf}
      ${EndIf}
    FunctionEnd

    ; The folder page, the only callback that's its own alone: NSIS calls it as the page opens and
    ; whenever the folder changes.
    ; - Already installed: the page is moved past, once, so a newer Setup updates WhimWatch where it
    ;   is. The message is posted, not sent: the page is still being built when this first runs.
    ; - Otherwise the button reads Install (the page after this one, wwSettleDir, is never shown, but
    ;   it makes NSIS label this one Next), and it's greyed out while the folder can't be used.
    ; - Back is greyed out: the only page before this one is the install-mode page, which skips
    ;   itself (customInstallMode), and Back onto a page that skips with nothing before it closes
    ;   Setup, silently and with exit code 0.
    Function .onVerifyInstDir
      ${If} $wwDirSeen != 1
        StrCpy $wwDirSeen 1
        ${If} $perUserInstallationFolder != ""
          System::Call "user32::PostMessage(p $HWNDPARENT, i 0x408, p 1, p 0)"
        ${EndIf}
      ${EndIf}
      GetDlgItem $wwPart $HWNDPARENT 3
      EnableWindow $wwPart 0
      GetDlgItem $wwPart $HWNDPARENT 1
      SendMessage $wwPart ${WM_SETTEXT} 0 "STR:$(^InstallBtn)"
      StrCpy $wwDir $INSTDIR
      Call wwFinalDir
      Call wwCheckDir
      ${If} $wwUsable != 1
        Abort
      ${EndIf}
    FunctionEnd
  !endif
!macroend

; $wwDir under BASE (the folder itself or anything in it): $wwUsable becomes 0.
!macro wwUnder BASE
  ${If} "${BASE}" != ""
    StrLen $wwPart "${BASE}"
    StrCpy $wwName $wwDir $wwPart
    ${If} $wwName == "${BASE}"
      StrCpy $wwName $wwDir 1 $wwPart
      ${If} $wwName == "\"
      ${OrIf} $wwName == ""
        StrCpy $wwUsable 0
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

; Before any page, and for a silent install the only chance: the default, or /D=…. Not for an
; install being updated in its own folder, which stays where it is.
!macro customInit
  Call wwSetText
  ${IfNot} ${isUpdated}
  ${AndIf} $INSTDIR != $perUserInstallationFolder
    StrCpy $wwDir $INSTDIR
    Call wwFinalDir
    StrCpy $INSTDIR $wwDir
    ${If} ${Silent}
      Call wwCheckDir
      ${If} $wwUsable != 1
        SetErrorLevel 2
        Quit
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

; After the folder page: the folder chosen becomes the WhimWatch folder inside it. No page is shown.
!macro customPageAfterChangeDir
  Page custom wwSettleDir
  Function wwSettleDir
    ${IfNot} ${isUpdated}
    ${AndIf} $INSTDIR != $perUserInstallationFolder
      StrCpy $wwDir $INSTDIR
      Call wwFinalDir
      StrCpy $INSTDIR $wwDir
    ${EndIf}
    Abort
  FunctionEnd
!macroend

; The Start menu entry, which electron-builder's own template can quietly fail to create.
;
; Its addStartMenuLink only calls CreateShortCut while $keepShortcuts is "false". The first install
; writes KeepShortcuts="true" under HKCU\Software\<app guid>, and from then on every install takes
; the other branch, which merely *renames* an existing shortcut — creating nothing when there is
; none. So once the shortcut has been deleted, no later install ever brings it back. Combined with
; no desktop shortcut, that leaves a successful install with nothing to show for itself; it also
; costs the user their update notifications, which Windows attaches to the Start menu entry.
;
; customInstall runs after addStartMenuLink, so this only fills a gap the template left.
!macro customInstall
  ${ifNot} ${FileExists} "$newStartMenuLink"
    !ifdef MENU_FILENAME
      CreateDirectory "$SMPROGRAMS\${MENU_FILENAME}"
      ClearErrors
    !endif
    CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ; Clear the error a shortcut that already exists would set.
    ClearErrors
    WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
    ; $launchLink was chosen before this existed. "Run WhimWatch now" should start it through the
    ; shortcut, so the running app carries the same identity Windows files its notifications under.
    StrCpy $launchLink "$newStartMenuLink"
  ${endIf}
!macroend

; The finish page. Its real job is to say the install worked: the one-click installer closed in
; silence whether or not anything had gone right, which is what people reported.
!macro customFinishPage
  !ifndef HIDE_RUN_AFTER_FINISH
    Function StartAppAfterFinish
      ${if} ${isUpdated}
        StrCpy $1 "--updated"
      ${else}
        StrCpy $1 ""
      ${endif}
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
    FunctionEnd

    !define MUI_FINISHPAGE_RUN
    !define MUI_FINISHPAGE_RUN_FUNCTION "StartAppAfterFinish"
  !endif

  ; MUI's "show readme" checkbox, used for the desktop shortcut instead. Left unticked on purpose:
  ; WhimWatch tracks adult mods, so putting its name on the desktop of a shared computer is
  ; something to be asked for rather than assumed. createDesktopShortcut stays false in
  ; electron-builder.yml, so this checkbox is the only thing that ever makes one.
  Function CreateDesktopShortcutAfterFinish
    CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
    System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
  FunctionEnd

  !define MUI_FINISHPAGE_SHOWREADME ""
  !define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED
  !define MUI_FINISHPAGE_SHOWREADME_TEXT "Create a desktop shortcut"
  !define MUI_FINISHPAGE_SHOWREADME_FUNCTION "CreateDesktopShortcutAfterFinish"

  !insertmacro MUI_PAGE_FINISH
!macroend

; Uninstalling asks whether to remove WhimWatch's data too. Skipped when an update
; reinstalls the app (--updated) and in silent uninstalls, which keep the data.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ; The desktop shortcut comes from the finish-page checkbox above, which is outside the template's
    ; own desktop handling — with createDesktopShortcut false its uninstaller never looks for one, so
    ; without this the shortcut would outlive the app.
    WinShell::UninstShortcut "$newDesktopLink"
    Delete "$newDesktopLink"
    ${if} $oldDesktopLink != $newDesktopLink
      WinShell::UninstShortcut "$oldDesktopLink"
      Delete "$oldDesktopLink"
    ${endIf}

    ${ifNot} ${Silent}
      MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also delete WhimWatch's settings, sign-ins, logs and backups of replaced mod files?$\r$\n$\r$\nYour Mods folder isn't changed either way." IDNO whimwatch_keep_data
        ; Electron keeps data per user, even for a per-machine install.
        SetShellVarContext current
        RMDir /r "$APPDATA\${PRODUCT_FILENAME}"
        RMDir /r "$TEMP\whimwatch"
        ${if} $installMode == "all"
          SetShellVarContext all
        ${endif}
      whimwatch_keep_data:
    ${endIf}
  ${endIf}
!macroend
