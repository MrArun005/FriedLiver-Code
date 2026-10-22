// Spike W1 (ANTIGRAVITY-WINDOWS.md): run one program in a fresh AppContainer inside a
// kill-on-close Job object. Not product code.
// usage: sandbox.exe [--cap client|server|private]... [--rx PATH]... [--rw PATH]... [--timeout SEC] -- EXE ARGS...
#define UNICODE
#define _UNICODE
#include <windows.h>
#include <userenv.h>
#include <sddl.h>
#include <aclapi.h>
#include <stdio.h>
#include <wchar.h>

#define MAXP 32
static const wchar_t *paths[MAXP];
static DWORD masks[MAXP];
static int npaths;

static DWORD setAce(PSID sid, const wchar_t *path, DWORD mask, ACCESS_MODE mode) {
  PACL old = NULL, acl = NULL;
  PSECURITY_DESCRIPTOR sd = NULL;
  DWORD e = GetNamedSecurityInfoW(path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, NULL, NULL, &old, NULL, &sd);
  if (e) return e;
  DWORD attrs = GetFileAttributesW(path);
  EXPLICIT_ACCESS_W ea = {0};
  ea.grfAccessPermissions = mask;
  ea.grfAccessMode = mode;
  ea.grfInheritance = (attrs != INVALID_FILE_ATTRIBUTES && (attrs & FILE_ATTRIBUTE_DIRECTORY)) ? SUB_CONTAINERS_AND_OBJECTS_INHERIT : NO_INHERITANCE;
  ea.Trustee.TrusteeForm = TRUSTEE_IS_SID;
  ea.Trustee.TrusteeType = TRUSTEE_IS_WELL_KNOWN_GROUP;
  ea.Trustee.ptstrName = (LPWSTR)sid;
  e = SetEntriesInAclW(1, &ea, old, &acl);
  if (!e) e = SetNamedSecurityInfoW((LPWSTR)path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, NULL, NULL, acl, NULL);
  if (acl) LocalFree(acl);
  if (sd) LocalFree(sd);
  return e;
}

// CommandLineToArgvW-compatible quoting of one argument.
static void appendArg(wchar_t *cmd, size_t cap, const wchar_t *a) {
  if (cmd[0]) wcscat_s(cmd, cap, L" ");
  if (*a && !wcspbrk(a, L" \t\"")) { wcscat_s(cmd, cap, a); return; }
  wcscat_s(cmd, cap, L"\"");
  for (const wchar_t *p = a;; p++) {
    size_t bs = 0;
    while (*p == L'\\') { bs++; p++; }
    size_t n = !*p ? bs * 2 : *p == L'"' ? bs * 2 + 1 : bs;
    for (size_t i = 0; i < n; i++) wcscat_s(cmd, cap, L"\\");
    if (!*p) break;
    wchar_t c[2] = {*p, 0};
    wcscat_s(cmd, cap, c);
  }
  wcscat_s(cmd, cap, L"\"");
}

int wmain(int argc, wchar_t **argv) {
  SID_AND_ATTRIBUTES caps[3];
  DWORD ncaps = 0, timeoutMs = 120000;
  int i = 1;
  for (; i < argc && wcscmp(argv[i], L"--"); i++) {
    if (i + 1 >= argc) return fwprintf(stderr, L"sandbox: missing value for %ls\n", argv[i]), 2;
    const wchar_t *v = argv[++i];
    if (!wcscmp(argv[i - 1], L"--cap")) {
      const wchar_t *s = !wcscmp(v, L"client") ? L"S-1-15-3-1" : !wcscmp(v, L"server") ? L"S-1-15-3-2" : !wcscmp(v, L"private") ? L"S-1-15-3-3" : NULL;
      if (!s || ncaps == 3 || !ConvertStringSidToSidW(s, &caps[ncaps].Sid)) return fwprintf(stderr, L"sandbox: bad cap %ls\n", v), 2;
      caps[ncaps++].Attributes = SE_GROUP_ENABLED;
    } else if (!wcscmp(argv[i - 1], L"--rx") || !wcscmp(argv[i - 1], L"--rw")) {
      if (npaths == MAXP) return 2;
      paths[npaths] = v;
      masks[npaths++] = argv[i - 1][3] == L'x' ? (GENERIC_READ | GENERIC_EXECUTE) : (GENERIC_READ | GENERIC_WRITE | GENERIC_EXECUTE | DELETE);
    } else if (!wcscmp(argv[i - 1], L"--timeout")) {
      timeoutMs = (DWORD)_wtoi(v) * 1000;
    } else return fwprintf(stderr, L"sandbox: unknown option %ls\n", argv[i - 1]), 2;
  }
  if (i + 1 >= argc) return fwprintf(stderr, L"sandbox: no program after --\n"), 2;

  // A fresh container per run: a random name, so its SID is never reused.
  wchar_t name[64];
  swprintf_s(name, 64, L"friedliver.spike.%lu.%llu", GetCurrentProcessId(), GetTickCount64());
  PSID sid = NULL;
  HRESULT hr = CreateAppContainerProfile(name, name, name, NULL, 0, &sid);
  if (FAILED(hr)) return fwprintf(stderr, L"sandbox: CreateAppContainerProfile 0x%08lx\n", hr), 3;

  int rc = 3;
  for (int p = 0; p < npaths; p++) {
    DWORD e = setAce(sid, paths[p], masks[p], GRANT_ACCESS);
    if (e) { fwprintf(stderr, L"sandbox: grant %ls failed %lu\n", paths[p], e); goto done; }
  }

  SECURITY_CAPABILITIES sc = {sid, ncaps ? caps : NULL, ncaps, 0};
  SIZE_T size = 0;
  InitializeProcThreadAttributeList(NULL, 1, 0, &size);
  LPPROC_THREAD_ATTRIBUTE_LIST attrs = (LPPROC_THREAD_ATTRIBUTE_LIST)HeapAlloc(GetProcessHeap(), 0, size);
  if (!InitializeProcThreadAttributeList(attrs, 1, 0, &size) ||
      !UpdateProcThreadAttribute(attrs, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, &sc, sizeof sc, NULL, NULL)) {
    fwprintf(stderr, L"sandbox: attribute list %lu\n", GetLastError());
    goto done;
  }

  HANDLE job = CreateJobObjectW(NULL, NULL);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION li = {0};
  li.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; // no BREAKAWAY_OK
  if (!job || !SetInformationJobObject(job, JobObjectExtendedLimitInformation, &li, sizeof li)) {
    fwprintf(stderr, L"sandbox: job %lu\n", GetLastError());
    goto done;
  }

  static wchar_t cmd[32768];
  for (int a = i + 1; a < argc; a++) appendArg(cmd, 32768, argv[a]);

  STARTUPINFOEXW si = {0};
  si.StartupInfo.cb = sizeof si;
  si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  HANDLE std[3] = {GetStdHandle(STD_INPUT_HANDLE), GetStdHandle(STD_OUTPUT_HANDLE), GetStdHandle(STD_ERROR_HANDLE)};
  for (int h = 0; h < 3; h++) SetHandleInformation(std[h], HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
  si.StartupInfo.hStdInput = std[0];
  si.StartupInfo.hStdOutput = std[1];
  si.StartupInfo.hStdError = std[2];
  si.lpAttributeList = attrs;
  PROCESS_INFORMATION pi;
  if (!CreateProcessW(argv[i + 1], cmd, NULL, NULL, TRUE, EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED, NULL, NULL, &si.StartupInfo, &pi)) {
    fwprintf(stderr, L"sandbox: CreateProcess %ls failed %lu\n", argv[i + 1], GetLastError());
    goto done;
  }
  if (!AssignProcessToJobObject(job, pi.hProcess)) {
    fwprintf(stderr, L"sandbox: AssignProcessToJobObject %lu\n", GetLastError());
    TerminateProcess(pi.hProcess, 1);
    goto done;
  }
  ResumeThread(pi.hThread);
  if (WaitForSingleObject(pi.hProcess, timeoutMs) == WAIT_TIMEOUT) {
    fwprintf(stderr, L"sandbox: timed out after %lu s\n", timeoutMs / 1000);
    rc = 124;
  } else {
    DWORD code = 1;
    GetExitCodeProcess(pi.hProcess, &code);
    rc = (int)code;
  }
  TerminateJobObject(job, 1); // everything the program started goes with it
  CloseHandle(job);

done:
  for (int p = 0; p < npaths; p++) setAce(sid, paths[p], 0, REVOKE_ACCESS);
  FreeSid(sid);
  DeleteAppContainerProfile(name);
  fwprintf(stderr, L"sandbox: exit %d\n", rc);
  return rc;
}
