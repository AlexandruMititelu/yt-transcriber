#!/usr/bin/env node
// Native messaging host for YT Transcriber: the extension's only way to touch the filesystem.
// Protocol: 4-byte LE length + JSON, both directions. Request {id, op, ...} → reply {id, ok, ...}.
// Ops: ping | pick-folder | list {path} | read {path} | stat {path} | write {path, content} | delete {path} | rename {from, to} | mkdir {path}
// File ops carry `root` (the vault's YT-transcriber dir); any path outside it is refused.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const VERSION = '1';

function send(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([head, body]));
}

// Windows: IFileOpenDialog + FOS_PICKFOLDERS = the modern Explorer picker. (FolderBrowserDialog under
// Windows PowerShell 5.1 / .NET Framework is the XP-era tree.) The C# shim is written to a temp .ps1 once.
const WIN_PICKER_PS1 = String.raw`param([switch]$Check)
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class YtxFolderPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] class FileOpenDialogRCW {}
  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
    void SetFileTypeIndex(uint iFileType);
    void GetFileTypeIndex(out uint piFileType);
    void Advise(IntPtr pfde, out uint pdwCookie);
    void Unadvise(uint dwCookie);
    void SetOptions(uint fos);
    void GetOptions(out uint pfos);
    void SetDefaultFolder(IShellItem psi);
    void SetFolder(IShellItem psi);
    void GetFolder(out IShellItem ppsi);
    void GetCurrentSelection(out IShellItem ppsi);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
    void GetResult(out IShellItem ppsi);
    void AddPlace(IShellItem psi, int fdap);
    void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
    void Close(int hr);
    void SetClientGuid(ref Guid guid);
    void ClearClientData();
    void SetFilter(IntPtr pFilter);
  }
  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
    void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
    void Compare(IShellItem psi, uint hint, out int piOrder);
  }
  public static string Pick(string title) {
    var dlg = (IFileDialog)new FileOpenDialogRCW();
    uint opts; dlg.GetOptions(out opts);
    dlg.SetOptions(opts | 0x20u | 0x40u); // FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM
    dlg.SetTitle(title);
    dlg.SetOkButtonLabel("Select folder");
    if (dlg.Show(IntPtr.Zero) != 0) return null;
    IShellItem item; dlg.GetResult(out item);
    string path; item.GetDisplayName(0x80058000u, out path); // SIGDN_FILESYSPATH
    return path;
  }
}
"@
if ($Check) { exit 0 }
$p = [YtxFolderPicker]::Pick("Choose your knowledge base folder")
if ($p) { [Console]::Out.Write($p) }
`;

function pickFolder() {
  return new Promise((resolve) => {
    let cmd;
    let args;
    if (process.platform === 'win32') {
      const ps1 = path.join(os.tmpdir(), 'ytx-pick-folder.ps1');
      fs.writeFileSync(ps1, WIN_PICKER_PS1);
      cmd = 'powershell';
      args = ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', ps1];
    } else if (process.platform === 'darwin') {
      cmd = 'osascript';
      args = ['-e', 'POSIX path of (choose folder with prompt "Choose your knowledge base folder")'];
    } else {
      cmd = 'zenity';
      args = ['--file-selection', '--directory', '--title=Choose your knowledge base folder'];
    }
    execFile(cmd, args, { windowsHide: true }, (err, stdout) => {
      const p = (stdout || '').trim().replace(/[\\/]+$/, '');
      resolve(!err && p ? p : null);
    });
  });
}

// Resolve `p` and make sure it stays inside msg.root. The extension is the only client, but a
// confused message must not turn into "write anywhere the user can".
export function confine(root, p) {
  if (!root) throw new Error('missing root');
  const r = path.resolve(String(root));
  const q = path.resolve(String(p ?? ''));
  const rel = path.relative(r, q);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`path outside root: ${p}`);
  return q;
}

const mtimeOf = async (p) => { try { return Math.round((await fs.promises.stat(p)).mtimeMs); } catch { return null; } };

async function handle(msg) {
  const { op } = msg;
  if (op === 'ping') return { version: VERSION, platform: process.platform };
  if (op === 'pick-folder') return { path: await pickFolder() };
  const at = (p) => confine(msg.root, p);
  if (op === 'list') {
    try {
      const ents = await fs.promises.readdir(at(msg.path), { withFileTypes: true });
      return { entries: ents.map((e) => ({ name: e.name, dir: e.isDirectory() })) };
    } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return { entries: [] };
      throw e;
    }
  }
  if (op === 'read') {
    const p = at(msg.path);
    try {
      return { content: await fs.promises.readFile(p, 'utf8'), mtime: await mtimeOf(p) };
    } catch (e) {
      if (e.code === 'ENOENT') return { content: null, mtime: null };
      throw e;
    }
  }
  if (op === 'stat') return { mtime: await mtimeOf(at(msg.path)) };
  if (op === 'write') {
    const p = at(msg.path);
    await fs.promises.mkdir(path.dirname(p), { recursive: true });
    await fs.promises.writeFile(p, String(msg.content ?? ''), 'utf8');
    return { mtime: await mtimeOf(p) };
  }
  if (op === 'mkdir') {
    await fs.promises.mkdir(at(msg.path), { recursive: true });
    return {};
  }
  if (op === 'delete') {
    await fs.promises.rm(at(msg.path), { force: true, recursive: false });
    return {};
  }
  if (op === 'rename') {
    const to = at(msg.to);
    await fs.promises.mkdir(path.dirname(to), { recursive: true });
    await fs.promises.rename(at(msg.from), to);
    return {};
  }
  throw new Error(`unknown op: ${op}`);
}

// Requests run strictly in order: a write followed by a read/rename of the same file must see the write.
const MAX_FRAME = 64 * 1024 * 1024; // a bogus length header must not make us buffer forever
let buf = Buffer.alloc(0);
let queue = Promise.resolve();
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (len > MAX_FRAME) { send({ ok: false, error: 'frame too large' }); process.exit(1); }
    if (buf.length < 4 + len) break;
    let msg;
    try { msg = JSON.parse(buf.subarray(4, 4 + len).toString('utf8')); } catch { msg = { op: 'bad-json' }; }
    buf = buf.subarray(4 + len);
    const run = () => handle(msg)
      .then((r) => send({ id: msg.id, ok: true, ...r }))
      .catch((e) => send({ id: msg.id, ok: false, error: e.message }));
    // The folder dialog can sit open for minutes; never let it block file ops behind it.
    if (msg.op === 'pick-folder') run();
    else queue = queue.then(run);
  }
});
process.stdin.on('end', () => { queue.then(() => process.exit(0)); });
