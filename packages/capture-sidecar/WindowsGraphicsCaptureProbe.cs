using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using Vortice.Direct3D;
using Vortice.Direct3D11;
using Vortice.DXGI;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;
using WinRT;
using static Vortice.Direct3D11.D3D11;

namespace Hyyd.CaptureSidecar;

internal static class WindowsGraphicsCaptureProbe
{
    public static async Task<Bitmap> CaptureWindowAsync(IntPtr hwnd, TimeSpan timeout)
    {
        if (!GraphicsCaptureSession.IsSupported())
        {
            throw new InvalidOperationException("Windows Graphics Capture is not supported on this system.");
        }

        using var capture = WgcSession.Start(hwnd);
        var deadline = DateTimeOffset.UtcNow + timeout;
        while (DateTimeOffset.UtcNow < deadline)
        {
            var bitmap = capture.TryGetLatestBitmap();
            if (bitmap is not null)
            {
                return bitmap;
            }

            await Task.Delay(50);
        }

        throw new TimeoutException($"Windows Graphics Capture did not produce a frame within {timeout.TotalMilliseconds:0}ms.");
    }

    private sealed class WgcSession : IDisposable
    {
        private readonly object _lock = new();
        private bool _disposed;
        private ID3D11Device? _d3dDevice;
        private ID3D11DeviceContext? _d3dContext;
        private ID3D11Texture2D? _stagingTexture;
        private IDirect3DDevice? _winrtD3DDevice;
        private GraphicsCaptureItem? _item;
        private Direct3D11CaptureFramePool? _framePool;
        private GraphicsCaptureSession? _session;
        private Direct3D11CaptureFrame? _latestFrame;

        private WgcSession()
        {
        }

        public static WgcSession Start(IntPtr hwnd)
        {
            var session = new WgcSession();
            session.Initialize(hwnd);
            return session;
        }

        public Bitmap? TryGetLatestBitmap()
        {
            lock (_lock)
            {
                if (_disposed || _latestFrame is null || _d3dDevice is null || _d3dContext is null)
                {
                    return null;
                }

                var surfacePtr = MarshalInterface<IDirect3DSurface>.FromManaged(_latestFrame.Surface);
                try
                {
                    var access = (IDirect3DDxgiInterfaceAccess)Marshal.GetObjectForIUnknown(surfacePtr);
                    var textureIid = new Guid("6f15aaf2-d208-4e89-9ab4-489535d34f9c");
                    Marshal.ThrowExceptionForHR(access.GetInterface(ref textureIid, out var texturePtr));
                    using var sourceTexture = new ID3D11Texture2D(texturePtr);
                    EnsureStagingTexture(sourceTexture.Description);

                    _d3dContext.CopyResource(_stagingTexture, sourceTexture);
                    var mapped = _d3dContext.Map(_stagingTexture, 0, MapMode.Read, Vortice.Direct3D11.MapFlags.None);
                    try
                    {
                        return CopyMappedTextureToBitmap(
                            mapped.DataPointer,
                            checked((int)sourceTexture.Description.Width),
                            checked((int)sourceTexture.Description.Height),
                            checked((int)mapped.RowPitch));
                    }
                    finally
                    {
                        _d3dContext.Unmap(_stagingTexture, 0);
                    }
                }
                finally
                {
                    Marshal.Release(surfacePtr);
                }
            }
        }

        public void Dispose()
        {
            lock (_lock)
            {
                if (_disposed) return;
                _disposed = true;

                _latestFrame?.Dispose();
                _session?.Dispose();
                _framePool?.Dispose();
                _winrtD3DDevice?.Dispose();
                _stagingTexture?.Dispose();
                _d3dContext?.Dispose();
                _d3dDevice?.Dispose();
                _item = null;
            }
        }

        private void Initialize(IntPtr hwnd)
        {
            CreateD3DDevice();
            _item = CreateItemForWindow(hwnd);
            if (_item is null)
            {
                throw new InvalidOperationException("CreateForWindow returned null GraphicsCaptureItem.");
            }

            _framePool = Direct3D11CaptureFramePool.CreateFreeThreaded(
                _winrtD3DDevice,
                DirectXPixelFormat.B8G8R8A8UIntNormalized,
                2,
                _item.Size);
            _framePool.FrameArrived += OnFrameArrived;

            _session = _framePool.CreateCaptureSession(_item);
            _session.IsCursorCaptureEnabled = false;
            _session.StartCapture();
        }

        private void CreateD3DDevice()
        {
            var result = D3D11CreateDevice(
                null,
                DriverType.Hardware,
                DeviceCreationFlags.BgraSupport,
                null,
                out _d3dDevice,
                out _,
                out _d3dContext);
            if (result.Failure)
            {
                result.CheckError();
            }

            using var dxgiDevice = _d3dDevice!.QueryInterface<IDXGIDevice>();
            Marshal.ThrowExceptionForHR(CreateDirect3D11DeviceFromDXGIDevice(dxgiDevice.NativePointer, out var inspectable));
            try
            {
                _winrtD3DDevice = MarshalInterface<IDirect3DDevice>.FromAbi(inspectable);
            }
            finally
            {
                Marshal.Release(inspectable);
            }
        }

        private static GraphicsCaptureItem CreateItemForWindow(IntPtr hwnd)
        {
            var interop = GraphicsCaptureItem.As<IGraphicsCaptureItemInterop>();
            var itemGuid = new Guid("79C3F95B-31F7-4EC2-A464-632EF5D30760");
            Marshal.ThrowExceptionForHR(interop.CreateForWindow(hwnd, ref itemGuid, out var itemPtr));
            try
            {
                return MarshalInterface<GraphicsCaptureItem>.FromAbi(itemPtr);
            }
            finally
            {
                Marshal.Release(itemPtr);
            }
        }

        private void OnFrameArrived(Direct3D11CaptureFramePool sender, object args)
        {
            lock (_lock)
            {
                if (_disposed)
                {
                    return;
                }

                using var frame = sender.TryGetNextFrame();
                if (frame is null)
                {
                    return;
                }

                if (_latestFrame is not null && frame.ContentSize != _latestFrame.ContentSize)
                {
                    var size = frame.ContentSize;
                    _latestFrame.Dispose();
                    _latestFrame = null;
                    _framePool?.Recreate(_winrtD3DDevice, DirectXPixelFormat.B8G8R8A8UIntNormalized, 2, size);
                    return;
                }

                _latestFrame?.Dispose();
                _latestFrame = frame;
            }
        }

        private void EnsureStagingTexture(Texture2DDescription sourceDesc)
        {
            if (_stagingTexture is not null &&
                _stagingTexture.Description.Width == sourceDesc.Width &&
                _stagingTexture.Description.Height == sourceDesc.Height)
            {
                return;
            }

            _stagingTexture?.Dispose();
            var desc = sourceDesc;
            desc.BindFlags = BindFlags.None;
            desc.CPUAccessFlags = CpuAccessFlags.Read;
            desc.Usage = ResourceUsage.Staging;
            desc.MiscFlags = ResourceOptionFlags.None;
            _stagingTexture = _d3dDevice!.CreateTexture2D(desc);
        }

        private static unsafe Bitmap CopyMappedTextureToBitmap(IntPtr sourcePointer, int width, int height, int sourceStride)
        {
            var bitmap = new Bitmap(width, height, PixelFormat.Format32bppPArgb);
            var data = bitmap.LockBits(
                new Rectangle(0, 0, width, height),
                ImageLockMode.WriteOnly,
                bitmap.PixelFormat);
            try
            {
                var source = (byte*)sourcePointer;
                var destination = (byte*)data.Scan0;
                var rowBytes = width * 4;
                for (var y = 0; y < height; y++)
                {
                    Buffer.MemoryCopy(source, destination, rowBytes, rowBytes);
                    source += sourceStride;
                    destination += data.Stride;
                }
            }
            finally
            {
                bitmap.UnlockBits(data);
            }

            return bitmap;
        }
    }

    [ComImport]
    [Guid("A9B3D012-3DF2-4EE3-B8D1-8695F457D3C1")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IDirect3DDxgiInterfaceAccess
    {
        [PreserveSig]
        int GetInterface(ref Guid iid, out IntPtr graphicsObject);
    }

    [ComImport]
    [Guid("3628e81b-3cac-4c60-b7f4-23ce0e0c3356")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IGraphicsCaptureItemInterop
    {
        [PreserveSig]
        int CreateForWindow(IntPtr window, ref Guid iid, out IntPtr result);

        [PreserveSig]
        int CreateForMonitor(IntPtr monitor, ref Guid iid, out IntPtr result);
    }

    [DllImport("d3d11.dll", ExactSpelling = true)]
    private static extern int CreateDirect3D11DeviceFromDXGIDevice(IntPtr dxgiDevice, out IntPtr graphicsDevice);
}
