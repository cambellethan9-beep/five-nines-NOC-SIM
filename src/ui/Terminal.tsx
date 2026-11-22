import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ConsoleSession, HostShell } from '../sim/host';
import type { Network } from '../sim/network';

interface Props {
  net: Network;
  deviceId: string;
  session: ConsoleSession;
  /** Changes every sim tick so the terminal can pick up logs and boot state. */
  tick: number;
  visible: boolean;
}

const BOOT_LINES = [
  'System Bootstrap, Version 15.1(4)M4, RELEASE SOFTWARE (fc1)',
  'Copyright (c) 2026 by NetSmart Systems, Inc.',
  'Total memory size = 512 MB - On-board = 512 MB, DIMM0 = 0 MB',
  'Readonly ROMMON initialized',
  '',
  'Self decompressing the image : ################################################ [OK]',
  '',
];

export function Terminal({ net, deviceId, session, tick, visible }: Props) {
  const isHost = !('mode' in session);
  const [lines, setLines] = useState<string[]>(() =>
    isHost ? ['NetSmart Workstation [Version 10.0.19045]', '(c) NetSmart Systems. All rights reserved.', ''] : ['', 'Press RETURN to get started.', ''],
  );
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [booting, setBooting] = useState(false);
  const history = useRef<string[]>([]);
  const histIndex = useRef(-1);
  const scroller = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const append = useCallback((more: string[]) => {
    if (more.length) setLines((prev) => [...prev, ...more].slice(-3000));
  }, []);

  // Each tick: print new console log messages and handle boot transitions.
  useEffect(() => {
    const device = net.device(deviceId);
    const nowBooting = !net.isOnline(device);
    if (nowBooting && !booting) append(BOOT_LINES);
    if (nowBooting !== booting) setBooting(nowBooting);
    append(session.pollLogs());
    append(session.checkBoot());
  }, [tick, net, deviceId, session, append, booting]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [lines, input]);

  useEffect(() => {
    if (visible) inputRef.current?.focus();
  }, [visible]);

  const submit = () => {
    const prompt = session.promptText();
    const echo = session.secretInput ? '' : input;
    const result = session.input(input);
    if (input.trim() && !session.secretInput) {
      history.current.push(input);
      if (history.current.length > 50) history.current.shift();
    }
    histIndex.current = -1;
    append([prompt + echo, ...result.output]);
    setInput('');
    if (result.delayed) {
      setBusy(true);
      const delayed = result.delayed;
      setTimeout(() => {
        append(delayed.output);
        setBusy(false);
        inputRef.current?.focus();
      }, delayed.ms);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (busy || booting) {
      e.preventDefault();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      submit();
    } else if (e.key === '?' && !session.secretInput && (!isHost || (session as HostShell).remoteActive)) {
      e.preventDefault();
      append([session.promptText() + input + '?', ...session.help(input)]);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      setInput(session.complete(input));
    } else if (e.key === 'z' && e.ctrlKey) {
      e.preventDefault();
      append([session.promptText() + input + '^Z', ...session.ctrlZ()]);
      setInput('');
    } else if (e.key === 'c' && e.ctrlKey) {
      e.preventDefault();
      append([session.promptText() + input + '^C']);
      setInput('');
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const h = history.current;
      if (!h.length) return;
      histIndex.current = histIndex.current === -1 ? h.length - 1 : Math.max(0, histIndex.current - 1);
      setInput(h[histIndex.current]);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const h = history.current;
      if (histIndex.current === -1) return;
      histIndex.current++;
      if (histIndex.current >= h.length) {
        histIndex.current = -1;
        setInput('');
      } else setInput(h[histIndex.current]);
    }
  };

  const showPrompt = !busy && !booting;
  return (
    <div className="terminal" style={{ display: visible ? 'flex' : 'none' }} onClick={() => inputRef.current?.focus()}>
      <div className="terminal-scroll" ref={scroller}>
        <pre className="terminal-text">{lines.join('\n')}</pre>
        <div className="terminal-input-row">
          {showPrompt && <span className="terminal-prompt">{session.promptText()}</span>}
          <input
            ref={inputRef}
            className="terminal-input"
            type={session.secretInput ? 'password' : 'text'}
            value={showPrompt ? input : ''}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            aria-label="Console input"
          />
        </div>
      </div>
    </div>
  );
}
