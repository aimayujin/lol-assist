Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential)]
public struct PROPERTYKEY { public Guid fmtid; public uint pid; }

[StructLayout(LayoutKind.Explicit)]
public struct PropVariant {
  [FieldOffset(0)] public ushort vt;
  [FieldOffset(8)] public IntPtr pwszVal;
}

[ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPropertyStore {
  int GetCount(out uint cProps);
  int GetAt(uint iProp, out PROPERTYKEY pkey);
  int GetValue(ref PROPERTYKEY key, out PropVariant pv);
}

[ComImport, Guid("00021401-0000-0000-C000-000000000046")]
public class CShellLink {}

[ComImport, Guid("0000010b-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPersistFile {
  void GetClassID(out Guid pClassID);
  int IsDirty();
  void Load([MarshalAs(UnmanagedType.LPWStr)] string path, uint mode);
}

public static class AumidReader {
  [DllImport("ole32.dll")] public static extern int PropVariantClear(ref PropVariant pv);
  public static string Read(string lnk) {
    var o = new CShellLink();
    ((IPersistFile)o).Load(lnk, 0);
    var store = (IPropertyStore)o;
    var key = new PROPERTYKEY { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 };
    PropVariant pv;
    store.GetValue(ref key, out pv);
    if (pv.vt == 31) return Marshal.PtrToStringUni(pv.pwszVal);
    return null;
  }
}
'@
$paths = @(
  "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\lolpick.jp.lnk",
  "$env:USERPROFILE\Desktop\lolpick.jp.lnk",
  "$env:USERPROFILE\OneDrive\Desktop\lolpick.jp.lnk",
  "$env:OneDrive\Desktop\lolpick.jp.lnk"
)
foreach ($p in $paths) {
  if (Test-Path $p) {
    Write-Host "SHORTCUT: $p"
    $aumid = [AumidReader]::Read($p)
    if ($null -eq $aumid) { Write-Host "  AUMID: (null)" }
    else { Write-Host "  AUMID: '$aumid'" }
  } else {
    Write-Host "(not found) $p"
  }
}
