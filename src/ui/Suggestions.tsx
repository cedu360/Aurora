import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { useStore } from '../store'
import { isPt, t } from '../lib/lang'

/**
 * Rotating example commands, shown only while idle.
 *
 * A voice interface has no menus — nothing tells you what it can do. This is
 * the affordance. It disappears the moment AURORA is doing anything, so it
 * never competes with the answer.
 *
 * Each line is phrased the way you'd actually say it, not as a feature name.
 */
const EXAMPLES_PT = [
  'o que aconteceu com inteligência artificial esta semana',
  'gere uma imagem da armadura Mark 7',
  'o que tem na minha agenda amanhã',
  'procure a melhor cafeteria perto de mim',
  'leia para mim a principal notícia do dia',
  'resuma o que chegou no meu e-mail',
  'lembre que a reunião com o fornecedor é sexta às 10',
  'o que você lembra sobre o Cápsula',
  'analise este executável com o REA',
  'como está o tempo hoje',
]

const EXAMPLES_EN = [
  'what happened in AI this week',
  'generate an image of the Mark Seven suit',
  'take a screenshot of my phone',
  "what's on my calendar tomorrow",
  'search for the best coffee near me',
  'read me the top story on Hacker News',
  'open my GitHub notifications',
  "summarise what's in my inbox",
  'find me a loading animation',
  "what's the weather looking like",
]

const EXAMPLES = isPt ? EXAMPLES_PT : EXAMPLES_EN

const ROTATE_MS = 4200

export function Suggestions() {
  const phase = useStore((s) => s.phase)
  const turns = useStore((s) => s.turns)
  const [i, setI] = useState(0)

  useEffect(() => {
    const id = setInterval(() => setI((n) => (n + 1) % EXAMPLES.length), ROTATE_MS)
    return () => clearInterval(id)
  }, [])

  // Only while genuinely idle, and only until the first exchange — once the
  // user knows how it works, the prompt is just clutter.
  if (phase !== 'dormant' || turns.length > 0) return null

  return (
    <div className="suggest">
      <span className="suggest-lead">{t('experimente', 'try')}</span>
      <AnimatePresence mode="wait">
        <motion.span
          key={i}
          className="suggest-text"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.35 }}
        >
          “{t('ei aurora', 'hey aurora')}, {EXAMPLES[i]}”
        </motion.span>
      </AnimatePresence>
    </div>
  )
}
