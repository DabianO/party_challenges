import { useEffect, useRef } from 'react';
import QRCode from 'qrcode';

export function QrCode({ value, size = 220, label }: { value: string; size?: number; label?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !value) return;
    QRCode.toCanvas(canvas, value, { width: size, margin: 1, color: { dark: '#000000', light: '#ffffff' } }).catch(() => {
      /* value too long or canvas unavailable — the URL text is shown next to the code anyway */
    });
  }, [value, size]);

  return (
    <div className="qr">
      <canvas ref={ref} width={size} height={size} role="img" aria-label={label ?? `QR code for ${value}`} />
    </div>
  );
}
