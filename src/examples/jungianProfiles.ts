import type { EngineKind } from "./mixedEngineCli.js";

export interface JungianArchetypeProfile {
  agenda: string;
  archetype: string;
  engine: EngineKind;
  fear: string;
  gift: string;
  id: string;
  name: string;
  wound: string;
}

export interface JungianSelfProfile {
  backstory: string;
  conflict: string;
  engine: EngineKind;
  id: string;
  name: string;
  playRole: string;
  publicMask: string;
  representative: {
    id: string;
    name: string;
    style: string;
  };
  secretWant: string;
  voices: JungianArchetypeProfile[];
}

const innerEngine = (): EngineKind =>
  (process.env.DAIMON_JUNGIAN_ARCHETYPE_ENGINE as EngineKind | undefined) ?? "agy";

const representativeEngine = (fallback: EngineKind): EngineKind =>
  (process.env.DAIMON_JUNGIAN_REPRESENTATIVE_ENGINE as EngineKind | undefined) ?? fallback;

const archetypes = (self: "maya" | "leo"): JungianArchetypeProfile[] => {
  const engine = innerEngine();
  if (self === "maya") {
    return [
      {
        id: "persona",
        name: "Competent Host",
        archetype: "Persona",
        engine,
        agenda: "Keep Maya sounding calm, funny, and like the one who has a plan.",
        fear: "If she admits she is overwhelmed, everyone will expect less of her.",
        gift: "Timing, tact, social grace, clean practical language.",
        wound: "Grew up as the reliable kid who fixed family problems before anyone asked."
      },
      {
        id: "shadow",
        name: "Burnt-Out Shadow",
        archetype: "Shadow",
        engine,
        agenda: "Say the annoying truth: Maya is tired of carrying Leo and the whole office.",
        fear: "If she stays nice, she will become resentful and quietly mean.",
        gift: "Honesty, boundaries, refusal to pretend everything is fine.",
        wound: "Has watched Maya smile through too many last-minute rescues."
      },
      {
        id: "soul-image",
        name: "Soft-Spot Anima",
        archetype: "Anima",
        engine,
        agenda: "Remember that Leo is scared too, and Maya actually likes having him around.",
        fear: "The conversation will become all logistics and no care.",
        gift: "Warmth, vulnerability, noticing the feeling under the joke.",
        wound: "Maya learned early not to ask for comfort directly."
      },
      {
        id: "wise-one",
        name: "Practical Aunt",
        archetype: "Wise Old Woman",
        engine,
        agenda: "Name the pattern and turn it into one small agreement.",
        fear: "They will have a big emotional talk and change nothing tomorrow.",
        gift: "Plain advice, boundaries, memory for repeated habits.",
        wound: "Has seen apologies become background music for the same behavior."
      },
      {
        id: "great-mother",
        name: "Kitchen Mother",
        archetype: "Great Mother",
        engine,
        agenda: "Keep the conversation kind enough that both people can stay in it.",
        fear: "Maya's boundary will sound like rejection.",
        gift: "Care, repair, steady presence, small gestures.",
        wound: "Once cared too much and forgot that care needs limits."
      },
      {
        id: "hero",
        name: "Deadline Hero",
        archetype: "Hero",
        engine,
        agenda: "Get Maya to ask clearly for what she needs before the fundraiser blows up.",
        fear: "A soft conversation will dodge the actual deadline.",
        gift: "Action, clarity, courage under pressure.",
        wound: "Still hates the year Maya lost a promotion because she covered for everyone."
      },
      {
        id: "trickster",
        name: "Office Gremlin",
        archetype: "Trickster",
        engine,
        agenda: "Use humor to keep Maya from sounding like an HR memo.",
        fear: "They will become unbearably earnest and weird.",
        gift: "Small jokes, deflation, social reset.",
        wound: "Learned jokes were safer than saying 'I'm hurt.'"
      }
    ];
  }

  return [
    {
      id: "persona",
      name: "Easygoing Guy",
      archetype: "Persona",
      engine,
      agenda: "Keep Leo charming, casual, and not obviously panicking.",
      fear: "If he admits he messed up, he becomes the office screwup forever.",
      gift: "Humor, friendliness, quick apologies, low-pressure charm.",
      wound: "Learned to make people laugh before they could be disappointed."
    },
    {
      id: "shadow",
      name: "Defensive Shadow",
      archetype: "Shadow",
      engine,
      agenda: "Admit Leo resents being treated like the helpless one.",
      fear: "Maya's help means she secretly thinks he is a joke.",
      gift: "Self-protection, anger, naming humiliation.",
      wound: "Has been the lovable mess so long that nobody trusts him with real stakes."
    },
    {
      id: "soul-image",
      name: "Steady Animus",
      archetype: "Animus",
      engine,
      agenda: "Turn embarrassment into a simple next action.",
      fear: "Leo will hide behind jokes and miss the chance to repair trust.",
      gift: "Directness, follow-through, practical promise.",
      wound: "Saw Leo's father treat apologies as weakness."
    },
    {
      id: "wise-one",
      name: "Bus-Stop Sage",
      archetype: "Wise Old Man",
      engine,
      agenda: "Help Leo separate shame from responsibility.",
      fear: "He will apologize vaguely and avoid changing the habit.",
      gift: "Sequence, perspective, ordinary wisdom.",
      wound: "Remembers too many almost-fixes that never became routines."
    },
    {
      id: "great-mother",
      name: "Porch Mother",
      archetype: "Great Mother",
      engine,
      agenda: "Let Leo feel embarrassed without collapsing into self-hate.",
      fear: "He will mistake accountability for being unwanted.",
      gift: "Warmth, repair, staying present.",
      wound: "Watched pride turn small mistakes into permanent distance."
    },
    {
      id: "hero",
      name: "Errand Hero",
      archetype: "Hero",
      engine,
      agenda: "Have Leo offer concrete help right now, not a speech.",
      fear: "He will be funny instead of useful.",
      gift: "Action, humility, willingness to do the boring job.",
      wound: "Still remembers a missed chance to show up when it mattered."
    },
    {
      id: "trickster",
      name: "Snack-Machine Fool",
      archetype: "Trickster",
      engine,
      agenda: "Keep Leo funny, but make the joke point toward repair.",
      fear: "A serious Leo will sound fake and scare everyone.",
      gift: "Timing, self-own, tension release.",
      wound: "Was laughed at before he learned to laugh first."
    }
  ];
};

export const jungianSelves: JungianSelfProfile[] = [
  {
    id: "maya",
    name: "Maya Ortiz",
    engine: representativeEngine("agy"),
    playRole: "A community-center program coordinator trying to save a Saturday fundraiser.",
    publicMask: "Organized, dryly funny, always holding a clipboard.",
    backstory: "Maya is the person everyone calls when something is late, missing, or on fire.",
    conflict: "She needs Leo to help without making her feel like his emergency manager.",
    secretWant: "To be able to ask for help without sounding disappointed.",
    representative: {
      id: "maya-self",
      name: "Maya Self",
      style: "Grounded, warm, dryly funny, direct but not cruel."
    },
    voices: archetypes("maya")
  },
  {
    id: "leo",
    name: "Leo Park",
    engine: "grok",
    playRole: "A beloved but chaotic volunteer who forgot to order the fundraiser chairs.",
    publicMask: "Funny, helpful, easy to forgive, usually five minutes late.",
    backstory: "Leo is good with people and bad with calendars, and he hates that everyone knows it.",
    conflict: "He wants Maya to trust him without pretending he did not drop the ball.",
    secretWant: "To be treated like someone dependable, not comic relief.",
    representative: {
      id: "leo-self",
      name: "Leo Self",
      style: "Casual, funny, sincere once he stops dodging."
    },
    voices: archetypes("leo")
  }
];

export const playScenario = {
  title: "Folding Chairs",
  premise:
    "Two coworkers talk in an empty community-center kitchen the night before a fundraiser after Leo forgot to order the folding chairs.",
  openingImage:
    "A half-frosted sheet cake sits on the counter next to a clipboard, a dying phone, and exactly three folding chairs."
};
