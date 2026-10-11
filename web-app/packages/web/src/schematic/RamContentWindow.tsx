/**
 * Port of `Gates.RAMContentWindow` (0.9.4): live view of a RAM 8k's memory, opened from the
 * component's `Obsah` context menu. The JavaFX stage becomes a non-modal floating panel in the
 * schematic page (one per RAM); it refreshes every 200 ms and only re-renders on a real change.
 */
import { schematic } from '@cpuemul/engine';
import { IconButton, Paper } from '@mui/material';
import { useEffect, useRef, useState } from 'react';

const REFRESH_MS = 200;

const textAreaStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  resize: 'none',
  fontFamily: 'monospace',
  fontSize: 11,
  whiteSpace: 'pre',
  overflow: 'auto',
};

export function RamContentWindow(props: { ram: schematic.Ram8k; offset: number; onClose: () => void }) {
  const [content, setContent] = useState(() => schematic.ramContentText(props.ram.getMemory()));
  const last = useRef(content.hex);

  useEffect(() => {
    const timer = setInterval(() => {
      const next = schematic.ramContentText(props.ram.getMemory());
      if (next.hex === last.current) return;
      last.current = next.hex;
      setContent(next);
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [props.ram]);

  return (
    <Paper
      elevation={8}
      role="dialog"
      aria-label="Obsah pamäte RAM 8k"
      style={{
        position: 'absolute',
        left: 40 + props.offset * 24,
        top: 40 + props.offset * 24,
        width: 820,
        height: 540,
        maxWidth: 'calc(100% - 16px)',
        maxHeight: 'calc(100% - 16px)',
        minWidth: 320,
        display: 'flex',
        flexDirection: 'column',
        zIndex: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', padding: '4px 8px', borderBottom: '1px solid #ddd' }}>
        <img src="/icons/ram.png" alt="" width={16} height={16} style={{ marginRight: 6 }} />
        <span style={{ flex: 1, fontSize: 13 }}>Obsah pamäte RAM 8k</span>
        <IconButton size="small" aria-label="Zavrieť" onClick={props.onClose}>
          ✕
        </IconButton>
      </div>
      <div style={{ display: 'flex', gap: 10, padding: 8, flex: 1, minHeight: 0 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 56, minWidth: 0 }}>
          <span style={{ fontSize: 13 }}>Adresa / HEX</span>
          <textarea readOnly tabIndex={-1} value={content.hex} style={textAreaStyle} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 36, minWidth: 0 }}>
          <span style={{ fontSize: 13 }}>ASCII</span>
          <textarea readOnly tabIndex={-1} value={content.ascii} style={textAreaStyle} />
        </div>
      </div>
    </Paper>
  );
}
