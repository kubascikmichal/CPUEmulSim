/**
 * Menu bar, toolbar and status bar of the CPU window (Main_CPUEmul.fxml top/bottom).
 */
import { Box, Button, Divider, LinearProgress, ListItemIcon, Menu, MenuItem, Slider, Tooltip, Typography } from '@mui/material';
import { useState, type MouseEvent, type ReactNode } from 'react';
import { cpuController as ctl } from './controller';

const icon = (name: string, size = 16) => <img src={`/icons/${name}.png`} width={size} height={size} alt="" draggable={false} />;

function MenuButton({ label, children }: { label: string; children: (close: () => void) => ReactNode }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <Button
        variant="text"
        sx={{ background: 'none', border: 'none', color: '#000', px: 1.5, borderRadius: 0, '&:hover': { background: '#dbe8f5' } }}
        onClick={(e: MouseEvent<HTMLElement>) => setAnchor(e.currentTarget)}
      >
        {label}
      </Button>
      <Menu anchorEl={anchor} open={anchor !== null} onClose={() => setAnchor(null)} transitionDuration={0}>
        {children(() => setAnchor(null))}
      </Menu>
    </>
  );
}

function Item(props: { text: string; accel?: string; icon?: string; checked?: boolean; onClick: () => void; close: () => void }) {
  return (
    <MenuItem
      onClick={() => {
        props.close();
        props.onClick();
      }}
      sx={{ minWidth: 220 }}
    >
      <ListItemIcon sx={{ minWidth: '24px !important' }}>
        {props.icon ? icon(props.icon) : props.checked !== undefined ? (props.checked ? '✓' : '') : ''}
      </ListItemIcon>
      <Box sx={{ flex: 1 }}>{props.text}</Box>
      {props.accel && <Typography sx={{ fontSize: 12, color: '#666', ml: 3 }}>{props.accel}</Typography>}
    </MenuItem>
  );
}

export function MenuBar() {
  const session = ctl.session;
  const scheduler = ctl.runtime.scheduler;
  return (
    <Box sx={{ display: 'flex', borderBottom: '1px solid #c8c8c8', background: 'linear-gradient(#f7f7f7,#e5e5e5)' }}>
      <MenuButton label="Súbor">
        {(close) => [
          <Item key="n" text="Nový" accel="Ctrl+N" icon="file" onClick={() => void ctl.newFile()} close={close} />,
          <Item key="o" text="Otvoriť..." accel="Ctrl+O" icon="open" onClick={() => void ctl.openFile()} close={close} />,
          <Item key="s" text="Uložiť" accel="Ctrl+S" icon="save" onClick={() => void ctl.saveCode(false)} close={close} />,
          <Item key="sa" text="Uložiť ako..." accel="Shift+Ctrl+S" icon="save-as" onClick={() => void ctl.saveCode(true)} close={close} />,
          <Item key="dl" text="Stiahnuť do počítača..." icon="save-as" onClick={() => ctl.downloadCode()} close={close} />,
          <Divider key="d" />,
          <Item key="k" text="Koniec" icon="close-window" onClick={() => void ctl.exitMenu()} close={close} />,
        ]}
      </MenuButton>
      <MenuButton label="Nastavenia">
        {(close) => [
          <Item key="il" text="INT - Level" checked={session.isIntByLevel()} onClick={() => ctl.setIntByLevel(true)} close={close} />,
          <Item key="ic" text="INT - Zmena" checked={!session.isIntByLevel()} onClick={() => ctl.setIntByLevel(false)} close={close} />,
          <Divider key="d1" />,
          <Item key="m" text="Mikro krokovanie" checked={session.isMicrostep()} onClick={() => ctl.setMicrostep(!session.isMicrostep())} close={close} />,
          <Divider key="d2" />,
          <Item
            key="g"
            text="Povoliť aktualizáciu GUI"
            checked={scheduler.allowUpdateGUI}
            onClick={() => ctl.setAllowUpdateGUI(!scheduler.allowUpdateGUI)}
            close={close}
          />,
        ]}
      </MenuButton>
      <MenuButton label="Pomoc">
        {(close) => <Item text="O programe..." onClick={() => void ctl.dialogs?.about()} close={close} />}
      </MenuButton>
    </Box>
  );
}

function IconButton({ name, tip, onClick }: { name: string; tip: string; onClick: () => void }) {
  return (
    <Tooltip title={tip} disableInteractive>
      <Button onClick={onClick} sx={{ minWidth: 30, px: 0.5 }}>
        {icon(name)}
      </Button>
    </Tooltip>
  );
}

function CtlButton({ name, text, enabled, onClick }: { name: string; text: string; enabled: boolean; onClick: () => void }) {
  return (
    <Button disabled={!enabled} onClick={onClick} startIcon={icon(name)} sx={{ minWidth: 100, justifyContent: 'flex-start' }}>
      {text}
    </Button>
  );
}

export function Toolbar() {
  const v = ctl.session.view;
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 2.5, py: 1, borderBottom: '1px solid #d0d0d0' }}>
      <IconButton name="file" tip="Nový kód" onClick={() => void ctl.newFile()} />
      <IconButton name="open" tip="Otvoriť kód" onClick={() => void ctl.openFile()} />
      <IconButton name="save" tip="Uložiť kód" onClick={() => void ctl.saveCode(false)} />
      <IconButton name="save-as" tip="Uložiť kód ako" onClick={() => void ctl.saveCode(true)} />
      <Box sx={{ width: 16 }} />
      <CtlButton name="check" text="Syntax [F4]" enabled={v.parseEnabled} onClick={() => ctl.parse()} />
      <CtlButton name="play" text={v.startText} enabled={v.startEnabled} onClick={() => ctl.start()} />
      <CtlButton name="step-over" text="Krok [F7]" enabled={v.stepEnabled} onClick={() => ctl.step()} />
      <CtlButton name="pause" text="Pauza [F9]" enabled={v.pauseEnabled} onClick={() => ctl.pause()} />
      <CtlButton name="stop" text="Stop [F10]" enabled={v.stopEnabled} onClick={() => ctl.stop()} />
      <CtlButton name="reset" text="Reset [F12]" enabled={v.resetEnabled} onClick={() => ctl.reset()} />
      <Box sx={{ width: 40 }} />
      <Button onClick={() => ctl.toggleSchematicWindow?.()}>Simulátor</Button>
    </Box>
  );
}

/**
 * Slider 10–150, major tick 10, 5 minor ticks, snapToTicks: JavaFX snaps to the nearest tick
 * (major/(minor+1) spacing) and the label shows the truncated int.
 */
const TICK = 10 / 6;
const snapToTick = (v: number) => 10 + Math.round((v - 10) / TICK) * TICK;

export function StatusBar() {
  const v = ctl.session.view;
  const scheduler = ctl.runtime.scheduler;
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2.5, px: 2, py: 0.75, borderTop: '1px solid #d0d0d0' }}>
      <Box sx={{ width: 200 }}>
        {v.progress < 0 ? (
          <LinearProgress sx={{ height: 10 }} />
        ) : (
          <LinearProgress variant="determinate" value={v.progress * 100} sx={{ height: 10 }} />
        )}
      </Box>
      <Typography sx={{ fontSize: 13, flex: 1 }} data-testid="status">
        {v.statusText}
      </Typography>
      <Box
        sx={{ display: 'flex', alignItems: 'center', gap: 1.25, opacity: scheduler.allowUpdateGUI ? 1 : 0.4, pointerEvents: scheduler.allowUpdateGUI ? 'auto' : 'none' }}
      >
        <Typography sx={{ fontSize: 13 }}>Interval obnovy GUI</Typography>
        <Slider
          size="small"
          min={10}
          max={150}
          step={TICK}
          value={scheduler.guiUpdateInterval}
          onChange={(_, val) => ctl.setGuiInterval(Math.trunc(snapToTick(val as number)))}
          sx={{ width: 140 }}
        />
        <Typography sx={{ fontSize: 13, minWidth: 25, textAlign: 'right' }}>{Math.trunc(scheduler.guiUpdateInterval)}</Typography>
        <Typography sx={{ fontSize: 13 }}>ms</Typography>
      </Box>
    </Box>
  );
}
