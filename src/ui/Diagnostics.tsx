import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { t as tr } from '../lib/lang'

/**
 * The "why can't he hear me / why can't I hear him" panel.
 *
 * Both halves of the voice loop fail silently by nature. Speech recognition
 * that ignores you and speech synthesis that produces no sound look identical
 * from the outside — nothing throws, nothing logs, the interface carries on as
 * though it were working. Every bug in this loop has therefore cost a round
 * trip of guesswork, and that is the actual problem this fixes: it is not a
 * developer toy, it is the instrument that turns "it doesn't work" into a
 * specific, answerable fact.
 *
 * Press D to show it. It polls rather than subscribing, because the two
 * diagnostic records are plain mutable objects written from outside React —
 * that is deliberate, since the whole point is to observe the loop without
 * changing its timing.
 */

type VoiceDiag = {
  running: boolean
  sessions: number
  heard: string
  heardAt: number
  lastError: string
  wakes: number
  mode: string
  dropped: string
  accepted: number
  restarts: number
  idleMs: number
}

type TtsDiag = {
  engine: string
  spoken: number
  started: number
  failures: number
  lastError: string
  nativeBroken: boolean
  rescued: number
  voice: string
  lastText: string
}

const ago = (t: number) =>
  t ? tr(`há ${((Date.now() - t) / 1000).toFixed(1)}s`, `${((Date.now() - t) / 1000).toFixed(1)}s ago`) : '—'

function Row({ k, v, bad }: { k: string; v: string; bad?: boolean }) {
  return (
    <div className="diag-row">
      <span className="diag-k">{k}</span>
      <span className={bad ? 'diag-v diag-bad' : 'diag-v'}>{v}</span>
    </div>
  )
}

export function Diagnostics() {
  const [open, setOpen] = useState(false)
  const [, tick] = useState(0)
  const phase = useStore((s) => s.phase)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === 'd' && !e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!open) return
    const id = setInterval(() => tick((n) => n + 1), 250)
    return () => clearInterval(id)
  }, [open])

  if (!open) return null

  const w = window as unknown as Record<string, unknown>
  const v = (w.__voice ?? {}) as Partial<VoiceDiag>
  const t = (w.__tts ?? {}) as Partial<TtsDiag>

  // The two verdicts worth stating outright, rather than making you infer them
  // from the numbers underneath.
  const earsOk = Boolean(v.running) && (v.accepted ?? 0) > 0
  const mouthOk = (t.started ?? 0) > 0 || (t.rescued ?? 0) > 0

  return (
    <div className="diag" aria-live="polite">
      <div className="diag-head">{tr('DIAGNÓSTICO · D para fechar', 'DIAGNOSTICS · D to close')}</div>

      <div className="diag-verdict">
        <span className={earsOk ? 'diag-ok' : 'diag-bad'}>
          {earsOk ? tr('● ouvindo você', '● hearing you') : tr('● não estou ouvindo você', '● not hearing you')}
        </span>
        <span className={mouthOk ? 'diag-ok' : 'diag-bad'}>
          {mouthOk ? tr('● falando', '● speaking') : tr('● nenhum som produzido', '● no sound produced')}
        </span>
      </div>

      <div className="diag-sec">{tr('ESCUTA', 'LISTENING')}</div>
      <Row k={tr('reconhecedor', 'recogniser')} v={v.running ? tr('rodando', 'running') : tr('PARADO', 'STOPPED')} bad={!v.running} />
      <Row k={tr('sessões', 'sessions')} v={String(v.sessions ?? 0)} />
      <Row
        k={tr('em silêncio há', 'silent for')}
        v={`${((v.idleMs ?? 0) / 1000).toFixed(1)}s`}
        bad={(v.idleMs ?? 0) > 15000}
      />
      <Row k={tr('reinícios forçados', 'forced restarts')} v={String(v.restarts ?? 0)} bad={(v.restarts ?? 0) > 0} />
      <Row k={tr('modo', 'mode')} v={`${v.mode ?? '—'} (${tr('fase', 'phase')} ${phase})`} />
      <Row k={tr('aceitas', 'accepted')} v={String(v.accepted ?? 0)} bad={(v.accepted ?? 0) === 0} />
      <Row k={tr('chamadas', 'wakes')} v={String(v.wakes ?? 0)} />
      <Row k={tr('última fala', 'last heard')} v={v.heard ? `"${v.heard}" ${ago(v.heardAt ?? 0)}` : tr('— nada ainda', '— nothing yet')} bad={!v.heard} />
      <Row k={tr('último descarte', 'last drop')} v={v.dropped || '—'} bad={Boolean(v.dropped)} />
      <Row k={tr('erro', 'error')} v={v.lastError || '—'} bad={Boolean(v.lastError)} />

      <div className="diag-sec">{tr('FALA · aperte T para testar', 'SPEAKING · press T to test')}</div>
      <Row k={tr('motor', 'engine')} v={String(t.engine ?? 'system')} />
      <Row k={tr('voz', 'voice')} v={String(t.voice || '—')} />
      <Row k={tr('enviadas ao sistema', 'handed to OS')} v={String(t.spoken ?? 0)} />
      <Row k={tr('faladas de fato', 'actually spoke')} v={String(t.started ?? 0)} bad={(t.started ?? 0) === 0} />
      <Row k={tr('falhas', 'failures')} v={String(t.failures ?? 0)} bad={(t.failures ?? 0) > 0} />
      <Row k={tr('resgates na nuvem', 'cloud rescues')} v={String(t.rescued ?? 0)} />
      <Row k={tr('erro', 'error')} v={t.lastError || '—'} bad={Boolean(t.lastError)} />
    </div>
  )
}
