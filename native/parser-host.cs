using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

// Resource containment only: the parser still runs as the current Windows user.
internal static class ParserHost
{
    const uint ExtendedLimits = 9, AssociateCompletionPort = 7;
    const uint ProcessMemory = 0x100, JobMemory = 0x200, KillOnClose = 0x2000, ActiveProcessLimit = 8, DieOnException = 0x400;
    const uint Suspended = 4, NoWindow = 0x08000000, UseStdHandles = 0x100, ExtendedStartup = 0x80000;
    static readonly object JobLock = new object();
    static IntPtr job;
    static string reason;

    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long ProcessTime, JobTime; public uint Flags; public UIntPtr MinWorkingSet, MaxWorkingSet;
        public uint ActiveProcesses; public UIntPtr Affinity; public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadCount, WriteCount, OtherCount, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct Limits {
        public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessBytes, JobBytes, PeakProcessBytes, PeakJobBytes;
    }
    [StructLayout(LayoutKind.Sequential)] struct Completion { public IntPtr Key, Port; }
    [StructLayout(LayoutKind.Sequential)] struct Accounting {
        public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
        public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }
    [StructLayout(LayoutKind.Sequential)] struct Startup {
        public uint Size; public IntPtr Reserved, Desktop, Title;
        public uint X, Y, XSize, YSize, XChars, YChars, Fill, Flags;
        public ushort Show, ReservedSize; public IntPtr ReservedBytes, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup Startup; public IntPtr Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint Pid, Tid; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr handle, uint type, IntPtr info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr handle, uint type, out Limits info, uint length, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr handle, uint type, out Accounting info, uint length, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateIoCompletionPort(IntPtr file, IntPtr existing, UIntPtr key, uint threads);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetQueuedCompletionStatus(IntPtr port, out uint message, out UIntPtr key, out IntPtr process, uint wait);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string cwd, ref StartupEx startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr attributes, int count, uint flags, ref UIntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr attributes, uint flags, UIntPtr attribute, IntPtr value, UIntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr attributes);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(IntPtr process, IntPtr handle, out bool member);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr handle, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint wait);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

    static void SetInfo<T>(uint type, T info) {
        int size = Marshal.SizeOf(typeof(T)); IntPtr memory = Marshal.AllocHGlobal(size);
        try { Marshal.StructureToPtr(info, memory, false); if (!SetInformationJobObject(job, type, memory, (uint)size)) throw new System.ComponentModel.Win32Exception(); }
        finally { Marshal.FreeHGlobal(memory); }
    }
    static void Stop(string status) {
        Interlocked.CompareExchange(ref reason, status, null);
        lock (JobLock) { if (job != IntPtr.Zero) TerminateJobObject(job, 1); }
    }
    static string Quote(string value) {
        StringBuilder result = new StringBuilder("\""); int slashes = 0;
        foreach (char character in value) {
            if (character == '\\') { slashes++; continue; }
            result.Append('\\', slashes * (character == '"' ? 2 : 1)); slashes = 0;
            if (character == '"') result.Append('\\'); result.Append(character);
        }
        result.Append('\\', slashes * 2); return result.Append('"').ToString();
    }
    static long Number(Dictionary<string, object> config, string key, long minimum, long maximum) {
        object value = config[key];
        if (!(value is int) && !(value is long)) throw new ArgumentException();
        long number = Convert.ToInt64(value); if (number < minimum || number > maximum) throw new ArgumentException(); return number;
    }
    static Dictionary<string, object> ReadConfig(Stream input) {
        byte[] bytes = new byte[65536]; int length = 0;
        while (true) { int value = input.ReadByte(); if (value < 0 || length == bytes.Length) throw new ArgumentException(); if (value == 10) break; bytes[length++] = (byte)value; }
        string line = new UTF8Encoding(false, true).GetString(bytes, 0, length);
        var serializer = new JavaScriptSerializer { MaxJsonLength = 65536, RecursionLimit = 10 };
        var config = serializer.DeserializeObject(line) as Dictionary<string, object>;
        if (config == null || config.Count != 5) throw new ArgumentException(); return config;
    }
    static int Main() {
        ProcessInfo child = new ProcessInfo(); IntPtr port = IntPtr.Zero, attributes = IntPtr.Zero, jobList = IntPtr.Zero;
        bool assigned = false, attributesInitialized = false;
        uint code = 1; ulong peakProcess = 0, peakJob = 0;
        try {
            Stream input = Console.OpenStandardInput(); var config = ReadConfig(input);
            string executable = config["executable"] as string;
            var args = config["args"] as object[];
            if (String.IsNullOrEmpty(executable) || !Path.IsPathRooted(executable) || executable.IndexOf('\0') >= 0 || !String.Equals(Path.GetFullPath(executable), executable, StringComparison.OrdinalIgnoreCase) || !File.Exists(executable) || args == null || args.Length > 64) throw new ArgumentException();
            long processBytes = Number(config, "processBytes", 16L << 20, 2L << 30), jobBytes = Number(config, "jobBytes", processBytes, 4L << 30);
            int timeout = (int)Number(config, "timeoutMs", 1, 180000);
            StringBuilder command = new StringBuilder(Quote(executable));
            foreach (object value in args) { string argument = value as string; if (argument == null || argument.IndexOf('\0') >= 0) throw new ArgumentException(); command.Append(' ').Append(Quote(argument)); }
            if (command.Length >= 32767) throw new ArgumentException();
            job = CreateJobObjectW(IntPtr.Zero, null); if (job == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
            SetInfo(ExtendedLimits, new Limits { Basic = new BasicLimits { Flags = ProcessMemory | JobMemory | KillOnClose | ActiveProcessLimit | DieOnException, ActiveProcesses = 8 }, ProcessBytes = new UIntPtr((ulong)processBytes), JobBytes = new UIntPtr((ulong)jobBytes) });
            port = CreateIoCompletionPort(new IntPtr(-1), IntPtr.Zero, UIntPtr.Zero, 1); if (port == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
            SetInfo(AssociateCompletionPort, new Completion { Key = new IntPtr(1), Port = port });
            UIntPtr attributeBytes = UIntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeBytes);
            if (attributeBytes == UIntPtr.Zero || attributeBytes.ToUInt64() > 65536) throw new System.ComponentModel.Win32Exception();
            attributes = Marshal.AllocHGlobal((int)attributeBytes.ToUInt64());
            if (!InitializeProcThreadAttributeList(attributes, 1, 0, ref attributeBytes)) throw new System.ComponentModel.Win32Exception();
            attributesInitialized = true; jobList = Marshal.AllocHGlobal(IntPtr.Size); Marshal.WriteIntPtr(jobList, job);
            // Windows 10+ assigns the job atomically at creation: abrupt host death cannot orphan a suspended child.
            if (!UpdateProcThreadAttribute(attributes, 0, new UIntPtr(0x2000D), jobList, new UIntPtr((uint)IntPtr.Size), IntPtr.Zero, IntPtr.Zero)) throw new System.ComponentModel.Win32Exception();
            StartupEx startup = new StartupEx { Startup = new Startup { Size = (uint)Marshal.SizeOf(typeof(StartupEx)), Flags = UseStdHandles }, Attributes = attributes };
            if (!CreateProcessW(executable, command, IntPtr.Zero, IntPtr.Zero, false, Suspended | NoWindow | ExtendedStartup, IntPtr.Zero, Path.GetDirectoryName(executable), ref startup, out child)) throw new System.ComponentModel.Win32Exception();
            if (!IsProcessInJob(child.Process, job, out assigned) || !assigned) throw new System.ComponentModel.Win32Exception();
            if (ResumeThread(child.Thread) == UInt32.MaxValue) throw new System.ComponentModel.Win32Exception();
            CloseHandle(child.Thread); child.Thread = IntPtr.Zero;
            new Thread(() => { try { while (input.ReadByte() >= 0) {} } catch {} Stop("parent-exit"); }) { IsBackground = true }.Start();
            var clock = System.Diagnostics.Stopwatch.StartNew();
            while (true) {
                uint message; UIntPtr key; IntPtr process;
                // Memory-limit notifications terminate the whole tree even if an allocator retries.
                if (GetQueuedCompletionStatus(port, out message, out key, out process, 10) && (message == 3 || message == 9 || message == 10)) Stop("resource-limit");
                if (WaitForSingleObject(child.Process, 0) == 0) {
                    while (GetQueuedCompletionStatus(port, out message, out key, out process, 0)) if (message == 3 || message == 9 || message == 10) Stop("resource-limit");
                    if (!GetExitCodeProcess(child.Process, out code)) throw new System.ComponentModel.Win32Exception();
                    Interlocked.CompareExchange(ref reason, "completed", null); break;
                }
                if (clock.ElapsedMilliseconds >= timeout) Stop("timeout");
            }
        }
        catch (Exception error) {
            Interlocked.CompareExchange(ref reason, "setup-error", null);
            var nativeError = error as System.ComponentModel.Win32Exception; code = nativeError == null ? 87U : unchecked((uint)nativeError.NativeErrorCode);
        }
        finally {
            // This explicit cleanup also handles verification/resume failures; atomic assignment covers abrupt host death.
            if (child.Process != IntPtr.Zero) { TerminateProcess(child.Process, 1); WaitForSingleObject(child.Process, 5000); }
            lock (JobLock) {
                if (job != IntPtr.Zero) {
                    TerminateJobObject(job, 1);
                    var cleanup = System.Diagnostics.Stopwatch.StartNew(); Accounting accounting;
                    while (QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero) && accounting.ActiveProcesses != 0 && cleanup.ElapsedMilliseconds < 5000) Thread.Sleep(10);
                    Limits limits;
                    if (QueryInformationJobObject(job, ExtendedLimits, out limits, (uint)Marshal.SizeOf(typeof(Limits)), IntPtr.Zero)) { peakProcess = limits.PeakProcessBytes.ToUInt64(); peakJob = limits.PeakJobBytes.ToUInt64(); }
                    CloseHandle(job); job = IntPtr.Zero;
                }
            }
            if (child.Thread != IntPtr.Zero) CloseHandle(child.Thread);
            if (child.Process != IntPtr.Zero) CloseHandle(child.Process);
            if (port != IntPtr.Zero) CloseHandle(port);
            if (attributesInitialized) DeleteProcThreadAttributeList(attributes);
            if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
            if (jobList != IntPtr.Zero) Marshal.FreeHGlobal(jobList);
        }
        Console.WriteLine(new JavaScriptSerializer().Serialize(new { status = reason ?? "setup-error", code = unchecked((int)code), pid = child.Pid, assigned = assigned, peakProcessBytes = peakProcess, peakJobBytes = peakJob }));
        return reason == "completed" && code == 0 ? 0 : 1;
    }
}
