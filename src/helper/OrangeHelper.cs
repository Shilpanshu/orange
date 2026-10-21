// Orange's native sidekick. Long-running; reads one JSON request per line on stdin and
// writes one JSON response per line on stdout: {"id":1,"ok":true,"result":...}
// Compiled with the .NET Framework csc.exe that ships with Windows (see scripts/build-helper.mjs).
using System;
using System.Collections;
using System.Collections.Generic;
using System.Collections.Specialized;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

static class OrangeHelper
{
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
    static readonly object WriteLock = new object();

    [STAThread]
    static void Main()
    {
        Console.InputEncoding = new UTF8Encoding(false);
        var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };
        Console.SetOut(stdout);
        string line;
        while ((line = Console.ReadLine()) != null)
        {
            if (line.Trim().Length == 0) continue;
            Dictionary<string, object> req = null;
            object id = null;
            try
            {
                req = Json.Deserialize<Dictionary<string, object>>(line);
                id = req.ContainsKey("id") ? req["id"] : null;
                var result = Handle((string)req["cmd"], req.ContainsKey("args") ? req["args"] as ArrayList : new ArrayList());
                Reply(id, true, result);
            }
            catch (Exception ex)
            {
                Reply(id, false, ex.Message);
            }
        }
    }

    static void Reply(object id, bool ok, object result)
    {
        var s = Json.Serialize(new Dictionary<string, object> { { "id", id }, { "ok", ok }, { "result", result } });
        lock (WriteLock) Console.WriteLine(s);
    }

    static List<string> Strings(ArrayList a)
    {
        var l = new List<string>();
        foreach (var o in a) l.Add(Convert.ToString(o));
        return l;
    }

    static object Handle(string cmd, ArrayList args)
    {
        switch (cmd)
        {
            case "ping": return "pong";
            case "selection": return Selection();
            case "copyFiles": return CopyFiles(Strings(args));
            case "share": return Share(Strings(args));
            default: throw new Exception("unknown command " + cmd);
        }
    }

    // ------------------------------------------------------------ Explorer selection

    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);

    static List<string> Selection()
    {
        var paths = new List<string>();
        IntPtr fg = GetForegroundWindow();
        var cls = new StringBuilder(256);
        GetClassName(fg, cls, 256);
        string c = cls.ToString();
        Type shellType = Type.GetTypeFromProgID("Shell.Application");
        dynamic shell = Activator.CreateInstance(shellType);
        try
        {
            if (c == "Progman" || c == "WorkerW")
            {
                // The desktop is a special shell view; reach it through IShellWindows.FindWindowSW.
                dynamic windows = shell.Windows();
                object loc = 0x0; // CSIDL_DESKTOP
                object empty = null;
                int hwnd;
                dynamic desk = windows.FindWindowSW(ref loc, ref empty, 8 /*SWC_DESKTOP*/, out hwnd, 1 /*SWFO_NEEDDISPATCH*/);
                if (desk != null) AddSelected(desk.Document, paths);
                return paths;
            }
            foreach (dynamic w in shell.Windows())
            {
                try
                {
                    if (new IntPtr((long)w.HWND) != fg) continue;
                    AddSelected(w.Document, paths);
                    break;
                }
                catch { }
            }
        }
        finally
        {
            Marshal.FinalReleaseComObject(shell);
        }
        return paths;
    }

    static void AddSelected(dynamic doc, List<string> paths)
    {
        foreach (dynamic item in doc.SelectedItems())
        {
            string p = item.Path;
            if (!string.IsNullOrEmpty(p) && (File.Exists(p) || Directory.Exists(p))) paths.Add(p);
        }
    }

    // ------------------------------------------------------------------ clipboard

    static bool CopyFiles(List<string> paths)
    {
        var list = new StringCollection();
        foreach (var p in paths) list.Add(p);
        Exception err = null;
        var t = new Thread(() =>
        {
            try
            {
                var data = new DataObject();
                data.SetFileDropList(list);
                // Mark as a copy (not cut) so Explorer pastes duplicates.
                data.SetData("Preferred DropEffect", new MemoryStream(BitConverter.GetBytes(5)));
                Clipboard.SetDataObject(data, true, 5, 100);
            }
            catch (Exception ex) { err = ex; }
        });
        t.SetApartmentState(ApartmentState.STA);
        t.Start();
        t.Join();
        if (err != null) throw err;
        return true;
    }

    // ---------------------------------------------------------------------- share

    static bool Share(List<string> paths)
    {
        if (paths.Count == 0) return false;
        // Explorer exposes the Windows share sheet as the "Windows.ModernShare" verb.
        Type shellType = Type.GetTypeFromProgID("Shell.Application");
        dynamic shell = Activator.CreateInstance(shellType);
        string first = paths[0];
        dynamic folder = shell.NameSpace(Path.GetDirectoryName(first));
        dynamic item = folder.ParseName(Path.GetFileName(first));
        item.InvokeVerbEx("Windows.ModernShare");
        return true;
    }
}
