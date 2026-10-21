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
        // No console here (winexe): read/write the raw pipes as UTF-8 instead of touching Console encodings.
        var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
        var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };
        Console.SetOut(stdout);
        string line;
        while ((line = stdin.ReadLine()) != null)
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

    // The Windows share sheet (Nearby Share, Mail, apps). Desktop apps reach it through
    // IDataTransferManagerInterop on a window they own, so we make a tiny one near the cursor,
    // hand the sheet a list of StorageFiles and keep the window alive until the sheet is done.
    [ComImport, Guid("3A3DCD6C-3EAB-43DC-BCDE-45671CE800C8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IDataTransferManagerInterop
    {
        IntPtr GetForWindow([In] IntPtr appWindow, [In] ref Guid riid);
        void ShowShareUIForWindow(IntPtr appWindow);
    }

    static readonly Guid DtmIid = new Guid("a5caee9b-8708-49d1-8d36-67d25a8da00c");

    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool AllowSetForegroundWindow(int pid);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();

    static object Share(List<string> paths)
    {
        var existing = new List<string>();
        foreach (var p in paths) if (File.Exists(p) || Directory.Exists(p)) existing.Add(p);
        if (existing.Count == 0) throw new Exception("Nothing to share");

        // Resolve the files first (async WinRT calls; fine to block on from here).
        var items = new List<Windows.Storage.IStorageItem>();
        foreach (var p in existing)
        {
            if (Directory.Exists(p))
                items.Add(Await(Windows.Storage.StorageFolder.GetFolderFromPathAsync(p)));
            else
                items.Add(Await(Windows.Storage.StorageFile.GetFileFromPathAsync(p)));
        }

        string error = null;
        var shown = new ManualResetEvent(false);
        var t = new Thread(() =>
        {
            Form form = null;
            try
            {
                var pt = Cursor.Position;
                form = new Form
                {
                    FormBorderStyle = FormBorderStyle.None,
                    ShowInTaskbar = false,
                    StartPosition = FormStartPosition.Manual,
                    Size = new System.Drawing.Size(1, 1),
                    Location = new System.Drawing.Point(pt.X, pt.Y),
                    TopMost = true,
                    Opacity = 0.01,
                    Text = "Orange share",
                };
                var timeout = new System.Windows.Forms.Timer { Interval = 180000 };
                timeout.Tick += (s, e) => form.Close();
                form.Shown += (s, e) =>
                {
                    try
                    {
                        IntPtr hwnd = form.Handle;
                        // Take the foreground so the sheet opens in front of whatever the user is in.
                        IntPtr fg = GetForegroundWindow();
                        uint fgThread = GetWindowThreadProcessId(fg, IntPtr.Zero);
                        uint me = GetCurrentThreadId();
                        if (fgThread != 0 && fgThread != me) AttachThreadInput(me, fgThread, true);
                        SetForegroundWindow(hwnd);
                        form.Activate();
                        if (fgThread != 0 && fgThread != me) AttachThreadInput(me, fgThread, false);

                        var interop = (IDataTransferManagerInterop)System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeMarshal
                            .GetActivationFactory(typeof(Windows.ApplicationModel.DataTransfer.DataTransferManager));
                        Guid iid = DtmIid;
                        IntPtr dtmPtr = interop.GetForWindow(hwnd, ref iid);
                        var dtm = (Windows.ApplicationModel.DataTransfer.DataTransferManager)
                            Marshal.GetObjectForIUnknown(dtmPtr);
                        Marshal.Release(dtmPtr);
                        dtm.DataRequested += (sender, args) =>
                        {
                            var data = args.Request.Data;
                            data.Properties.Title = existing.Count == 1 ? Path.GetFileName(existing[0]) : existing.Count + " files";
                            data.Properties.Description = existing.Count == 1 ? existing[0] : Path.GetDirectoryName(existing[0]);
                            data.SetStorageItems(items, true);
                        };
                        dtm.TargetApplicationChosen += (sender, args) =>
                        {
                            // The target app now owns the data; give it a moment, then go away.
                            form.BeginInvoke(new Action(() =>
                            {
                                timeout.Interval = 20000;
                                timeout.Stop();
                                timeout.Start();
                            }));
                        };
                        interop.ShowShareUIForWindow(hwnd);
                        timeout.Start();
                    }
                    catch (Exception ex)
                    {
                        error = ex.Message;
                        form.Close();
                    }
                    finally
                    {
                        shown.Set();
                    }
                };
                Application.Run(form);
            }
            catch (Exception ex)
            {
                error = ex.Message;
                shown.Set();
            }
        });
        t.SetApartmentState(ApartmentState.STA);
        t.IsBackground = true;
        t.Start();
        shown.WaitOne(10000);
        if (error != null)
        {
            // Last resort: Explorer's own share verb on the first file.
            try { ShareVerb(existing[0]); return "verb"; } catch { }
            throw new Exception(error);
        }
        return "sheet";
    }

    // Blocks on a WinRT async operation without the System.Runtime.WindowsRuntime helpers
    // (they need the SDK's union metadata, which csc on a plain Windows install doesn't have).
    static T Await<T>(Windows.Foundation.IAsyncOperation<T> op)
    {
        var until = DateTime.UtcNow.AddSeconds(15);
        while (op.Status == Windows.Foundation.AsyncStatus.Started)
        {
            if (DateTime.UtcNow > until) throw new Exception("Timed out opening the file");
            Thread.Sleep(5);
        }
        if (op.Status != Windows.Foundation.AsyncStatus.Completed)
            throw new Exception(op.ErrorCode != null ? op.ErrorCode.Message : "Could not open the file");
        return op.GetResults();
    }

    static void ShareVerb(string first)
    {
        Type shellType = Type.GetTypeFromProgID("Shell.Application");
        dynamic shell = Activator.CreateInstance(shellType);
        dynamic folder = shell.NameSpace(Path.GetDirectoryName(first));
        dynamic item = folder.ParseName(Path.GetFileName(first));
        item.InvokeVerbEx("Windows.ModernShare");
    }
}
