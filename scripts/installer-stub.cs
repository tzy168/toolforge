// 自解压安装器的桩。
//
// 为什么自己写：electron-builder 在 Windows 上出安装包要从 github.com 拉 nsis 与 winCodeSign，
// 本机 GitHub 不通；本机也没有 makensis、没有 7z 的 SFX 模块。
// 但 .NET Framework 的 csc 一定在（Windows 自带 4.x），于是「编译一个几百 KB 的桩
// + 把 zip 负载拼在它后面」就是唯一一条纯离线、可复现、可 diff 的安装包路线。
//
// 约定：安装包 = 桩 exe + 标记行 + zip 负载。桩从自己文件尾部找到标记，再从标记之后解压。
// 参数：/S 静默，/D=<目录> 指定安装目录（默认 %LOCALAPPDATA%\Programs\ToolForge）。
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Text;
using System.Windows.Forms;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

static class Program
{
    // 标记要足够长、且不会偶然出现在 zip 里；前后各带一个换行便于肉眼确认
    static readonly byte[] Marker = Encoding.ASCII.GetBytes("\nTF_SFX_V1\n");

    [STAThread]
    static int Main(string[] args)
    {
        bool silent = false;
        string target = null;
        foreach (string a in args)
        {
            if (a.Equals("/S", StringComparison.OrdinalIgnoreCase) || a.Equals("--silent", StringComparison.OrdinalIgnoreCase)) silent = true;
            else if (a.StartsWith("/D=", StringComparison.OrdinalIgnoreCase)) target = a.Substring(3).Trim('"');
        }
        if (target == null) target = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "ToolForge");
        target = Path.GetFullPath(target);

        try
        {
            string self = Assembly.GetExecutingAssembly().Location;
            if (string.IsNullOrEmpty(self)) self = Process.GetCurrentProcess().MainModule.FileName;
            long offset = FindPayload(self);
            if (offset < 0) { Fail("安装包损坏：找不到数据段", silent); return 2; }

            Directory.CreateDirectory(target);
            int files = Extract(self, offset, target);
            WriteUninstaller(target);
            CreateShortcuts(target);

            if (silent) return 0;
            MessageBox.Show("ToolForge 已安装到：\n" + target + "\n\n共 " + files + " 个文件。", "ToolForge", MessageBoxButtons.OK, MessageBoxIcon.Information);
            string exe = Path.Combine(target, "ToolForge.exe");
            if (File.Exists(exe)) Process.Start(new ProcessStartInfo(exe) { WorkingDirectory = target });
            return 0;
        }
        catch (Exception e)
        {
            Fail(e.ToString(), silent);
            return 1;
        }
    }

    static void Fail(string message, bool silent)
    {
        // 静默安装失败时没有界面，只能靠这个文件：把完整异常（含内部异常）写进 %TEMP%
        try
        {
            string logPath = Path.Combine(Path.GetTempPath(), "ToolForge-install-error.log");
            File.WriteAllText(logPath, DateTime.Now.ToString("s") + Environment.NewLine + message + Environment.NewLine, Encoding.UTF8);
        }
        catch { }
        if (!silent) MessageBox.Show(message, "ToolForge 安装失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
        else Console.Error.WriteLine(message);
    }
    /// 从文件尾部往前找标记，返回负载起始偏移
    static long FindPayload(string path)
    {
        const int Chunk = 1 << 20;
        using (FileStream fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            long len = fs.Length;
            for (long pos = len - Chunk; ; pos -= Chunk)
            {
                long from = pos < 0 ? 0 : pos;
                int size = (int)Math.Min(Chunk + Marker.Length, len - from);
                if (size <= 0) return -1;
                byte[] buf = new byte[size];
                fs.Seek(from, SeekOrigin.Begin);
                int read = 0;
                while (read < size)
                {
                    int n = fs.Read(buf, read, size - read);
                    if (n <= 0) break;
                    read += n;
                }
                int idx = LastIndexOf(buf, read, Marker);
                if (idx >= 0) return from + idx + Marker.Length;
                if (from == 0) return -1;
            }
        }
    }

    static int LastIndexOf(byte[] haystack, int length, byte[] needle)
    {
        for (int i = length - needle.Length; i >= 0; i--)
        {
            bool hit = true;
            for (int j = 0; j < needle.Length; j++)
            {
                if (haystack[i + j] != needle[j]) { hit = false; break; }
            }
            if (hit) return i;
        }
        return -1;
    }

    /// .NET Framework 的路径上限是 260 字符，resources/app/node_modules/npm 这类目录轻易就超了。
    /// 加 \\?\ 前缀走扩展路径语法可以绕过，不需要改系统策略或附带 app.config。
    static string Ext(string p)
    {
        if (p.StartsWith(@"\\?\")) return p;
        if (p.StartsWith(@"\\")) return @"\\?\UNC\" + p.Substring(2);
        return @"\\?\" + p;
    }
    // .NET Framework 的 Path 系列 API 会拒绝 \\?\ 前缀（那是 .NET Core 才认的写法），
    // 所以超过 240 字符的路径只能走 Win32：CreateDirectoryW / CreateFileW 都收扩展路径。
    // 短路径坚持用托管 API——能少一层出错的地方。
    const int GENERIC_WRITE = 0x40000000;
    const uint CREATE_ALWAYS = 2;
    const uint FILE_ATTRIBUTE_NORMAL = 0x80;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateDirectoryW(string lpPathName, IntPtr lpSecurityAttributes);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateFileW(string lpFileName, uint dwDesiredAccess, uint dwShareMode,
        IntPtr lpSecurityAttributes, uint dwCreationDisposition, uint dwFlagsAndAttributes, IntPtr hTemplateFile);

    static bool TooLong(string p) { return p.Length >= 240; }

    static void EnsureDirectory(string path)
    {
        if (!TooLong(path)) { Directory.CreateDirectory(path); return; }
        CreateDirectoryW(Ext(path), IntPtr.Zero);
    }

    static void WriteEntry(ZipArchiveEntry entry, string dest)
    {
        if (!TooLong(dest))
        {
            using (Stream src = entry.Open())
            using (FileStream dst = new FileStream(dest, FileMode.Create, FileAccess.Write)) src.CopyTo(dst);
            return;
        }
        IntPtr handle = CreateFileW(Ext(dest), GENERIC_WRITE, 0, IntPtr.Zero, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
        if (handle == new IntPtr(-1)) throw new IOException("写文件失败（Win32 错误 " + Marshal.GetLastWin32Error() + "）：" + dest);
        using (SafeFileHandle safe = new SafeFileHandle(handle, true))
        using (FileStream dst = new FileStream(safe, FileAccess.Write))
        using (Stream src = entry.Open()) src.CopyTo(dst);
    }

    [DllImport("kernel32.dll")]
    static extern uint GetLastError();

    static int Extract(string path, long offset, string target)
    {
        int count = 0;
        string root = target.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        using (FileStream fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
        using (SubStream sub = new SubStream(fs, offset))
        using (ZipArchive zip = new ZipArchive(sub, ZipArchiveMode.Read))
        {
            foreach (ZipArchiveEntry entry in zip.Entries)
            {
                string rel = entry.FullName.Replace('/', Path.DirectorySeparatorChar);
                // zip slip 用相对路径本身判定，不走 Path.GetFullPath：它在 .NET Framework 下遇到超长路径
                // 会直接抛 PathTooLongException，把一次正常安装变成「失败」，而超长路径恰恰是 npm 那种目录的常态
                if (rel.Contains("..") || Path.IsPathRooted(rel))
                    throw new InvalidDataException("安装包条目越界：" + entry.FullName);
                string dest = Path.Combine(target, rel);
                // 目录条目只有尾斜杠，先建目录再 continue：漏掉它会把目录当成空文件写出来
                if (entry.FullName.EndsWith("/")) { EnsureDirectory(dest); continue; }
                string parent = Path.GetDirectoryName(dest);
                if (!string.IsNullOrEmpty(parent)) EnsureDirectory(parent);
                WriteEntry(entry, dest);
                count++;
            }
        }
        return count;
    }

    /// 卸载脚本：安装器自己不会常驻，所以留一个能一键删干净的批处理
    static void WriteUninstaller(string target)
    {
        string exe = Path.Combine(target, "ToolForge.exe");
        string desktop = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "ToolForge.lnk");
        string programs = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "ToolForge");
        string[] lines = new string[]
        {
            "@echo off",
            "rem 先等自己退出，再删目录（批处理正在里面跑的时候删不掉）",
            "timeout /t 2 /nobreak >nul",
            "del /q \"" + desktop + "\" 2>nul",
            "rmdir /s /q \"" + programs + "\" 2>nul",
            "rmdir /s /q \"" + target + "\" 2>nul",
            "echo 已卸载。",
        };
        File.WriteAllText(Path.Combine(target, "卸载 ToolForge.bat"), string.Join("\r\n", lines), Encoding.Default);
    }

    static void CreateShortcuts(string target)
    {
        string exe = Path.Combine(target, "ToolForge.exe");
        if (!File.Exists(exe)) return;
        Type shellType = Type.GetTypeFromProgID("WScript.Shell");
        if (shellType == null) return;
        object shell = Activator.CreateInstance(shellType);
        MakeShortcut(shell, Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "ToolForge.lnk"), exe, target);
        MakeShortcut(shell, Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), "ToolForge", "ToolForge.lnk"), exe, target);
    }

    static void MakeShortcut(object shell, string linkPath, string exe, string workdir)
    {
        string dir = Path.GetDirectoryName(linkPath);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        object lnk = shell.GetType().InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { linkPath });
        lnk.GetType().InvokeMember("TargetPath", BindingFlags.SetProperty, null, lnk, new object[] { exe });
        lnk.GetType().InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, lnk, new object[] { workdir });
        lnk.GetType().InvokeMember("IconLocation", BindingFlags.SetProperty, null, lnk, new object[] { exe });
        lnk.GetType().InvokeMember("Save", BindingFlags.InvokeMethod, null, lnk, null);
    }
}

/// 把 [offset, end) 这段文件包装成可 Seek 的流：ZipArchive 要求 seekable，
/// 而「负载拼在 exe 后面」在文件系统里就是一整段连续字节，没必要先解出来再读。
sealed class SubStream : Stream
{
    readonly FileStream _base;
    readonly long _start;
    long _pos;

    public SubStream(FileStream baseStream, long start)
    {
        _base = baseStream;
        _start = start;
        _pos = 0;
    }

    public override bool CanRead { get { return true; } }
    public override bool CanSeek { get { return true; } }
    public override bool CanWrite { get { return false; } }
    public override long Length { get { return _base.Length - _start; } }
    public override long Position { get { return _pos; } set { _pos = value; } }

    public override int Read(byte[] buffer, int offset, int count)
    {
        long remain = Length - _pos;
        if (remain <= 0) return 0;
        if (count > remain) count = (int)remain;
        _base.Seek(_start + _pos, SeekOrigin.Begin);
        int n = _base.Read(buffer, offset, count);
        _pos += n;
        return n;
    }

    public override long Seek(long offset, SeekOrigin origin)
    {
        if (origin == SeekOrigin.Begin) _pos = offset;
        else if (origin == SeekOrigin.Current) _pos += offset;
        else _pos = Length + offset;
        return _pos;
    }

    public override void Flush() { }
    public override void SetLength(long value) { throw new NotSupportedException(); }
    public override void Write(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }
}
