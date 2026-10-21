# End-to-end check of the core interaction: start a real OLE file drag (the same kind Explorer
# starts), tap a modifier mid-drag, then drop on a wheel slice. Orange must be running.
# Usage: powershell -File scripts/test-drag.ps1 -File C:\path\to\file.png [-Key Shift] [-Slice 0] [-Slices 7]
param(
  [Parameter(Mandatory = $true)][string]$File,
  [ValidateSet('Shift', 'Ctrl', 'Alt')][string]$Key = 'Shift',
  [int]$Slice = 0,
  [int]$Slices = 8
)

Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

public static class DragSim {
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern void mouse_event(uint f, int x, int y, uint d, UIntPtr e);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint f, UIntPtr e);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  const uint LDOWN = 2, LUP = 4, KEYUP = 2;

  static void MoveTo(int x0, int y0, int x1, int y1, int steps) {
    for (int i = 1; i <= steps; i++) {
      SetCursorPos(x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps);
      mouse_event(1, 0, 0, 0, UIntPtr.Zero); // MOUSEEVENTF_MOVE so hooks see movement
      Thread.Sleep(15);
    }
  }

  public static string Run(string path, byte vk, int slice, int slices) {
    SetProcessDPIAware();
    var form = new Form { StartPosition = FormStartPosition.Manual, Location = new Point(200, 200), Size = new Size(300, 200), Text = "drag source", TopMost = true };
    string result = "none";
    form.Shown += (s, e) => {
      int sx = 350, sy = 300;
      SetCursorPos(sx, sy);
      Thread.Sleep(100);
      mouse_event(LDOWN, 0, 0, 0, UIntPtr.Zero);
      var t = new Thread(() => {
        Thread.Sleep(300);
        MoveTo(sx, sy, 700, 450, 20);
        Thread.Sleep(150);
        keybd_event(vk, 0, 0, UIntPtr.Zero);
        Thread.Sleep(60);
        keybd_event(vk, 0, KEYUP, UIntPtr.Zero);
        Thread.Sleep(400);
        // Wheel is centred where the key was tapped. Slice 0 sits at 12 o'clock.
        // Wheel radius is in DIPs; scale for the display.
        float scale = form.DeviceDpi / 96f;
        double a = 2 * Math.PI * slice / slices;
        int r = (int)(136 * scale);
        int tx = 700 + (int)(r * Math.Sin(a)), ty = 450 - (int)(r * Math.Cos(a));
        MoveTo(700, 450, tx, ty, 15);
        Thread.Sleep(300);
        mouse_event(LUP, 0, 0, 0, UIntPtr.Zero);
      });
      t.IsBackground = true;
      t.Start();
      var data = new DataObject();
      data.SetFileDropList(new System.Collections.Specialized.StringCollection { path });
      var effect = form.DoDragDrop(data, DragDropEffects.Copy | DragDropEffects.Move | DragDropEffects.Link);
      result = effect.ToString();
      form.Close();
    };
    Application.Run(form);
    return result;
  }
}
'@

$vk = @{ Shift = 0x10; Ctrl = 0x11; Alt = 0x12 }[$Key]
$res = [DragSim]::Run((Resolve-Path $File).Path, [byte]$vk, $Slice, $Slices)
"drop effect: $res"
