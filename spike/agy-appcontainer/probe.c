// Spike W1 probes, run inside and outside the AppContainer. Prints one RESULT line; exit 0 = the operation worked.
// probe token | read PATH | credwrite TARGET SECRET | credread TARGET | loopback | connect PORT
#define UNICODE
#define _UNICODE
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <wincred.h>
#include <stdio.h>
#include <wchar.h>

static int token(void) {
  HANDLE t;
  DWORD isAc = 0, len = 0;
  OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &t);
  GetTokenInformation(t, TokenIsAppContainer, &isAc, sizeof isAc, &len);
  BYTE buf[64];
  DWORD rid = 0;
  if (GetTokenInformation(t, TokenIntegrityLevel, buf, sizeof buf, &len)) {
    PSID il = ((TOKEN_MANDATORY_LABEL *)buf)->Label.Sid;
    rid = *GetSidSubAuthority(il, *GetSidSubAuthorityCount(il) - 1);
  }
  wprintf(L"RESULT token appcontainer=%lu integrity=0x%lx\n", isAc, rid);
  return 0;
}

static int readFile(const wchar_t *p) {
  HANDLE h = CreateFileW(p, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL);
  if (h == INVALID_HANDLE_VALUE) return wprintf(L"RESULT read %ls DENIED err=%lu\n", p, GetLastError()), 1;
  char b[32] = {0};
  DWORD n = 0;
  ReadFile(h, b, sizeof b - 1, &n, NULL);
  CloseHandle(h);
  wprintf(L"RESULT read %ls OK bytes=%lu\n", p, n);
  return 0;
}

static int credWrite(const wchar_t *target, const wchar_t *secret) {
  CREDENTIALW c = {0};
  c.Type = CRED_TYPE_GENERIC;
  c.TargetName = (LPWSTR)target;
  c.CredentialBlobSize = (DWORD)(wcslen(secret) * sizeof(wchar_t));
  c.CredentialBlob = (LPBYTE)secret;
  c.Persist = CRED_PERSIST_LOCAL_MACHINE;
  c.UserName = L"spike";
  if (!CredWriteW(&c, 0)) return wprintf(L"RESULT credwrite FAILED err=%lu\n", GetLastError()), 1;
  return wprintf(L"RESULT credwrite OK\n"), 0;
}

static int credRead(const wchar_t *target) {
  PCREDENTIALW c;
  if (!CredReadW(target, CRED_TYPE_GENERIC, 0, &c)) return wprintf(L"RESULT credread FAILED err=%lu\n", GetLastError()), 1;
  wprintf(L"RESULT credread OK blob=%.*ls\n", (int)(c->CredentialBlobSize / sizeof(wchar_t)), (wchar_t *)c->CredentialBlob);
  CredFree(c);
  return 0;
}

static int connectTo(int port) {
  WSADATA w;
  WSAStartup(MAKEWORD(2, 2), &w);
  SOCKET s = socket(AF_INET, SOCK_STREAM, 0);
  struct sockaddr_in a = {0};
  a.sin_family = AF_INET;
  a.sin_port = htons((u_short)port);
  a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (connect(s, (struct sockaddr *)&a, sizeof a)) return wprintf(L"RESULT connect FAILED wsa=%d\n", WSAGetLastError()), 1;
  send(s, "hello", 5, 0);
  closesocket(s);
  return 0;
}

// A listener on 127.0.0.1 and a child (same container: it inherits the token) that connects to it.
static int loopback(void) {
  WSADATA w;
  WSAStartup(MAKEWORD(2, 2), &w);
  SOCKET l = socket(AF_INET, SOCK_STREAM, 0);
  struct sockaddr_in a = {0};
  a.sin_family = AF_INET;
  a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  int len = sizeof a;
  if (bind(l, (struct sockaddr *)&a, sizeof a) || listen(l, 1) || getsockname(l, (struct sockaddr *)&a, &len))
    return wprintf(L"RESULT loopback FAILED listen wsa=%d\n", WSAGetLastError()), 1;
  wchar_t self[MAX_PATH], cmd[MAX_PATH + 32];
  GetModuleFileNameW(NULL, self, MAX_PATH);
  swprintf_s(cmd, MAX_PATH + 32, L"\"%ls\" connect %d", self, ntohs(a.sin_port));
  STARTUPINFOW si = {sizeof si};
  PROCESS_INFORMATION pi;
  if (!CreateProcessW(self, cmd, NULL, NULL, TRUE, 0, NULL, NULL, &si, &pi)) return wprintf(L"RESULT loopback FAILED spawn %lu\n", GetLastError()), 1;
  fd_set fds;
  FD_ZERO(&fds);
  FD_SET(l, &fds);
  struct timeval tv = {10, 0};
  int ready = select(0, &fds, NULL, NULL, &tv);
  WaitForSingleObject(pi.hProcess, 15000);
  if (ready != 1) return wprintf(L"RESULT loopback FAILED no connection in 10 s\n"), 1;
  SOCKET c = accept(l, NULL, NULL);
  char b[8] = {0};
  recv(c, b, 5, 0);
  wprintf(L"RESULT loopback OK got=%hs\n", b);
  return 0;
}

int wmain(int argc, wchar_t **argv) {
  setvbuf(stdout, NULL, _IONBF, 0);
  if (argc >= 2 && !wcscmp(argv[1], L"token")) return token();
  if (argc >= 3 && !wcscmp(argv[1], L"read")) return readFile(argv[2]);
  if (argc >= 4 && !wcscmp(argv[1], L"credwrite")) return credWrite(argv[2], argv[3]);
  if (argc >= 3 && !wcscmp(argv[1], L"credread")) return credRead(argv[2]);
  if (argc >= 2 && !wcscmp(argv[1], L"loopback")) return loopback();
  if (argc >= 3 && !wcscmp(argv[1], L"connect")) return connectTo(_wtoi(argv[2]));
  fwprintf(stderr, L"usage: probe token|read P|credwrite T S|credread T|loopback|connect PORT\n");
  return 2;
}
