# ショートカット (.lnk) の AppUserModelID を書き込む
param(
  [Parameter(Mandatory=$true)][string]$LnkPath,
  [Parameter(Mandatory=$true)][string]$Aumid
)

$source = @"
using System;
using System.Runtime.InteropServices;

namespace AumidSetter {
    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    public struct PROPERTYKEY {
        public Guid fmtid;
        public uint pid;
    }

    [StructLayout(LayoutKind.Explicit, Size = 24)]
    public struct PROPVARIANT {
        [FieldOffset(0)] public ushort vt;
        [FieldOffset(8)] public IntPtr pwszVal;
    }

    [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IPropertyStore {
        [PreserveSig] int GetCount(out uint c);
        [PreserveSig] int GetAt(uint i, out PROPERTYKEY k);
        [PreserveSig] int GetValue([In] ref PROPERTYKEY k, out PROPVARIANT v);
        [PreserveSig] int SetValue([In] ref PROPERTYKEY k, [In] ref PROPVARIANT v);
        [PreserveSig] int Commit();
    }

    [ComImport, Guid("0000010b-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IPersistFile {
        [PreserveSig] int GetClassID(out Guid pClassID);
        [PreserveSig] int IsDirty();
        [PreserveSig] int Load([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, uint dwMode);
        [PreserveSig] int Save([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, [MarshalAs(UnmanagedType.Bool)] bool fRemember);
        [PreserveSig] int SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string pszFileName);
        [PreserveSig] int GetCurFile(out IntPtr ppszFileName);
    }

    public static class Setter {
        static Guid CLSID_ShellLink = new Guid("00021401-0000-0000-C000-000000000046");

        public static void Run(string path, string aumid) {
            Type t = Type.GetTypeFromCLSID(CLSID_ShellLink);
            object link = Activator.CreateInstance(t);

            IPersistFile pf = (IPersistFile)link;
            int hr = pf.Load(path, 3); // STGM_READWRITE
            if (hr < 0) throw new Exception("Load HRESULT=0x" + hr.ToString("X8"));

            IPropertyStore store = (IPropertyStore)link;
            PROPERTYKEY key = new PROPERTYKEY {
                fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"),
                pid = 5
            };

            IntPtr strPtr = Marshal.StringToCoTaskMemUni(aumid);
            try {
                PROPVARIANT pv = new PROPVARIANT { vt = 31, pwszVal = strPtr };
                hr = store.SetValue(ref key, ref pv);
                if (hr < 0) throw new Exception("SetValue HRESULT=0x" + hr.ToString("X8"));
                hr = store.Commit();
                if (hr < 0) throw new Exception("Commit HRESULT=0x" + hr.ToString("X8"));
            } finally {
                Marshal.FreeCoTaskMem(strPtr);
            }

            hr = pf.Save(null, true);
            if (hr < 0) throw new Exception("Save HRESULT=0x" + hr.ToString("X8"));
        }
    }
}
"@

Add-Type -TypeDefinition $source -Language CSharp
[AumidSetter.Setter]::Run($LnkPath, $Aumid)
Write-Host "OK: set AUMID '$Aumid' on $LnkPath"
