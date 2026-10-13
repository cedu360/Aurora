import { LANG } from '../config'

/**
 * Everything about speech that depends on the language.
 *
 * The original JARVIS only spoke British English, and the assumption leaked
 * into several regexes at once: the wake phrase, the words that mean "stop",
 * the words that mean "I haven't finished", the words too common to count as
 * evidence of an echo, and a normaliser that deleted every accented letter.
 * They live here together so a language is one decision rather than five.
 *
 * Accents matter more than they look. A JavaScript regex without the `u` flag
 * treats "á" as a non-word character, so `\b` falls in the middle of "járvis"
 * and a normaliser written as [^a-z] turns "não" into "n o". Every pattern
 * below is built with `u` and uses \p{L} for its boundaries.
 */

export { LANG }

export const isPt = LANG.startsWith('pt')

/** Pick the line for the active language. Portuguese first, English second. */
export const t = (pt: string, en: string): string => (isPt ? pt : en)

/** A letter or digit on either side means we are inside a longer word. */
const B = '(?<![\\p{L}\\p{N}])'
const E = "(?![\\p{L}\\p{N}'’])"

/**
 * What people put before his name, in either language. Both sets are always
 * accepted: a Brazilian user saying "hey Jarvis" is ordinary, and an English
 * prefix costs nothing in Portuguese.
 */
const PREFIX = "(?:hey|hi|ok|okay|yo|ei|oi|olá|ola|e aí|e ai|fala|ô|ó)"

/**
 * His name, plus what recognisers hear instead of it.
 *
 * The English alternates are the original's: Chrome returns Travis, Jervis,
 * Jarvys or Java's for a perfectly clear "Jarvis". The Portuguese recogniser has
 * its own favourites, and Jarbas — a real Brazilian name — is the commonest.
 */
export const NAME =
  "(?:jarvis|jarvys|jervis|travis|jarviss|java's|jarv|járvis|jarviz|jarbas|jarves|javis|jávis)"

/** The wake phrase anywhere in a transcript. */
export const WAKE = new RegExp(`${B}(?:${PREFIX}[\\s,]*)?${NAME}${E}`, 'iu')

/** A bare vocative — "Jarvis", "ei Jarvis" — with nothing asked. */
export const BARE_NAME = new RegExp(`^\\s*(?:${PREFIX}[\\s,]*)?${NAME}[\\s,.!?]*$`, 'iu')

/** A leading vocative on a real command: "Jarvis, que horas são". */
export const LEADING_NAME = new RegExp(`^\\s*(?:${PREFIX}[\\s,]*)?${NAME}${E}[\\s,.:!?-]*`, 'iu')

/**
 * Ending on one of these means the sentence is not over, whatever the silence
 * says. Tested against the last word alone. Only closed-class words, and in
 * Portuguese none of the verbs that can end a complete question ("que horas
 * são" is finished; "o que é" is the only common trap and costs just a pause).
 */
const CONTINUES_EN =
  'and|or|but|so|because|since|if|when|while|that|which|who|whose|to|of|in|on|at|by|for|with|from|about|into|onto|over|under|between|through|the|a|an|my|your|his|her|its|our|their|is|are|was|were|be|been|do|does|did|have|has|had|can|could|would|should|will|shall|might|must|like|than|then|as|very|really|just|some|any|all|both|either|neither'
const CONTINUES_PT =
  'e|ou|mas|porque|pois|que|quando|enquanto|se|como|para|pra|pro|de|do|da|dos|das|em|no|na|nos|nas|num|numa|com|sem|por|pelo|pela|pelos|pelas|sobre|entre|até|o|a|os|as|um|uma|uns|umas|meu|minha|meus|minhas|seu|sua|seus|suas|nosso|nossa|ao|aos|à|às|muito|mais|também|então|tipo|vou|vai|quero|queria|pode|poderia|preciso|qual|quais'

export const CONTINUES = new RegExp(`^(?:${isPt ? CONTINUES_PT : CONTINUES_EN})[,;:]?$`, 'iu')

/**
 * Short words that must always cut through, even when they collide with what
 * he happens to be saying.
 *
 * Portuguese needs care that English did not. "Para" is "stop" and also the
 * commonest preposition in the language, and "não" is everywhere, so both only
 * count as a stop when they are the whole utterance. Matching them anywhere
 * would make every answer containing "para" interrupt itself.
 */
const OVERRIDE_EN =
  `${B}(?:stop|wait|jarvis|cancel|enough|quiet|hold on|shut up|never ?mind|forget it|no)${E}`
const OVERRIDE_PT =
  `${B}(?:pare|parar|para tudo|espera|espere|pera|peraí|perai|cancela|cancelar|chega|silêncio|silencio|quieto|cala a boca|deixa pra lá|deixa para lá|esquece|stop|jarvis|jarbas)${E}` +
  '|^\\s*(?:(?:para|não|nao)[\\s,.!]*)+$'

export const OVERRIDE = new RegExp(isPt ? OVERRIDE_PT : OVERRIDE_EN, 'iu')

/**
 * Words too common to be evidence of an echo. "E o segundo?" is an ordinary
 * follow-up and every word in it is likely to appear in the answer it follows,
 * so only distinctive words count as proof he is hearing himself.
 */
const STOP_EN =
  'a an the and or but so of to in on at by for with from is are was were be ' +
  'it its this that these those i you he she we they me him her them my your ' +
  'our their what which who how why when where do does did can could would ' +
  'should will shall not no yes if then than as about into over under out up ' +
  'down one two three first second third now here there just very really got ' +
  'get have has had say said tell me okay ok well right'
const STOP_PT =
  'a o as os um uma uns umas e ou mas de do da dos das em no na nos nas num numa ' +
  'por pelo pela pelos pelas para pra pro com sem que se como mais menos muito ' +
  'muita já não sim é são foi era ser estar está estão esta este isso isto esse ' +
  'essa aquele aquela eu você voce ele ela nós eles elas me te lhe meu minha seu ' +
  'sua nosso nossa qual quais quando onde porque também então aqui ali lá agora ' +
  'só bem ok tá certo senhor um dois três primeiro segundo terceiro tem ter vai ' +
  'vou fala diz disse'

export const STOP = new Set((isPt ? STOP_PT : STOP_EN).split(' '))

/** Lower-case, keep letters of any alphabet, collapse everything else. */
export const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
