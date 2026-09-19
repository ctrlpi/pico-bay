// Bridges a Windows COM port to the Node.js process through standard input and output.
// Configures the serial port using Win32 APIs and handles DTR/RTS control over a named pipe.

using System;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Threading;

class ComBridge {
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    static extern IntPtr CreateFile(string lpFileName, uint dwDesiredAccess, uint dwShareMode, IntPtr lpSecurityAttributes, uint dwCreationDisposition, uint dwFlagsAndAttributes, IntPtr hTemplateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool ReadFile(IntPtr hFile, byte[] lpBuffer, uint nNumberOfBytesToRead, out uint lpNumberOfBytesRead, IntPtr lpOverlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool WriteFile(IntPtr hFile, byte[] lpBuffer, uint nNumberOfBytesToWrite, out uint lpNumberOfBytesWritten, IntPtr lpOverlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetCommState(IntPtr hFile, ref DCB lpDCB);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetCommState(IntPtr hFile, ref DCB lpDCB);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetCommTimeouts(IntPtr hFile, ref COMMTIMEOUTS lpCommTimeouts);

    [DllImport("kernel32.dll")]
    static extern bool EscapeCommFunction(IntPtr hFile, uint dwFunc);

    [StructLayout(LayoutKind.Sequential)]
    struct DCB {
        public int DCBlength;
        public uint BaudRate;
        public uint Flags;
        public ushort wReserved;
        public ushort XonLim;
        public ushort XoffLim;
        public byte ByteSize;
        public byte Parity;
        public byte StopBits;
        public sbyte XonChar;
        public sbyte XoffChar;
        public sbyte ErrorChar;
        public sbyte EofChar;
        public sbyte EvtChar;
        public ushort wReserved1;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct COMMTIMEOUTS {
        public uint ReadIntervalTimeout;
        public uint ReadTotalTimeoutMultiplier;
        public uint ReadTotalTimeoutConstant;
        public uint WriteTotalTimeoutMultiplier;
        public uint WriteTotalTimeoutConstant;
    }

    const uint GENERIC_READ = 0x80000000;
    const uint GENERIC_WRITE = 0x40000000;
    const uint OPEN_EXISTING = 3;
    const uint FILE_ATTRIBUTE_NORMAL = 0x80;
    const int INVALID_HANDLE_VALUE = -1;

    const uint SETDTR = 5;
    const uint CLRDTR = 6;
    const uint SETRTS = 3;
    const uint CLRRTS = 4;

    static IntPtr hPort;

    static void Main(string[] args) {
        if (args.Length < 3) return;
        string portName = "\\\\.\\" + args[0];
        uint baudRate = uint.Parse(args[1]);
        string pipeName = args[2];

        hPort = CreateFile(portName, GENERIC_READ | GENERIC_WRITE, 0, IntPtr.Zero, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
        if (hPort == (IntPtr)INVALID_HANDLE_VALUE) {
            Environment.Exit(1);
        }

        DCB dcb = new DCB();
        dcb.DCBlength = Marshal.SizeOf(dcb);
        GetCommState(hPort, ref dcb);
        dcb.BaudRate = baudRate;
        dcb.ByteSize = 8;
        dcb.Parity = 0;
        dcb.StopBits = 0;
        dcb.Flags |= 0x01; // Binary
        SetCommState(hPort, ref dcb);

        COMMTIMEOUTS timeouts = new COMMTIMEOUTS();
        timeouts.ReadIntervalTimeout = 0xFFFFFFFF;
        timeouts.ReadTotalTimeoutMultiplier = 0;
        timeouts.ReadTotalTimeoutConstant = 0;
        timeouts.WriteTotalTimeoutMultiplier = 0;
        timeouts.WriteTotalTimeoutConstant = 0;
        SetCommTimeouts(hPort, ref timeouts);

        // Initial state
        SetDtr(true);
        SetRts(true);

        Thread readThread = new Thread(ReadPort);
        readThread.IsBackground = true;
        readThread.Start();

        Thread writeThread = new Thread(WritePort);
        writeThread.IsBackground = true;
        writeThread.Start();

        Thread pipeThread = new Thread(() => ControlPipe(pipeName));
        pipeThread.IsBackground = true;
        pipeThread.Start();

        readThread.Join();
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetCommModemStatus(IntPtr hFile, out uint lpModemStat);

    static void ReadPort() {
        byte[] buf = new byte[4096];
        uint read;
        uint stat;
        Stream stdout = Console.OpenStandardOutput();
        while (true) {
            if (ReadFile(hPort, buf, (uint)buf.Length, out read, IntPtr.Zero)) {
                if (read > 0) {
                    stdout.Write(buf, 0, (int)read);
                    stdout.Flush();
                } else {
                    if (!GetCommModemStatus(hPort, out stat)) break;
                    Thread.Sleep(1);
                }
            } else {
                break;
            }
        }
        Environment.Exit(0);
    }

    static void WritePort() {
        byte[] buf = new byte[4096];
        Stream stdin = Console.OpenStandardInput();
        uint written;
        while (true) {
            int count = stdin.Read(buf, 0, buf.Length);
            if (count <= 0) break;
            int offset = 0;
            while (count > 0) {
                byte[] chunk = new byte[count];
                Array.Copy(buf, offset, chunk, 0, count);
                if (!WriteFile(hPort, chunk, (uint)count, out written, IntPtr.Zero)) break;
                count -= (int)written;
                offset += (int)written;
            }
        }
        Environment.Exit(0);
    }

    static void ControlPipe(string pipeName) {
        if (pipeName == "none") return;
        try {
            using (NamedPipeClientStream pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.In)) {
                pipe.Connect();
                using (StreamReader reader = new StreamReader(pipe)) {
                    string line;
                    while ((line = reader.ReadLine()) != null) {
                        if (line.StartsWith("dtr:")) SetDtr(line.Substring(4) == "1");
                        else if (line.StartsWith("rts:")) SetRts(line.Substring(4) == "1");
                    }
                }
            }
        } catch { }
        Environment.Exit(0);
    }

    static void SetDtr(bool on) { EscapeCommFunction(hPort, on ? SETDTR : CLRDTR); }
    static void SetRts(bool on) { EscapeCommFunction(hPort, on ? SETRTS : CLRRTS); }
}
