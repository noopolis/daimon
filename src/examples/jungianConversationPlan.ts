import type { JungianSelfProfile } from "./jungianProfiles.js";

export interface DialogueBeat {
  focus: string;
  speakerId: string;
}

export const defaultDialogueTurns = 12;

export const dialogueBeats: DialogueBeat[] = [
  {
    speakerId: "maya",
    focus: "Start the conversation after Maya notices the chairs are missing. Be annoyed but human."
  },
  {
    speakerId: "leo",
    focus: "Answer without dodging. Admit what happened, but keep it conversational."
  },
  {
    speakerId: "maya",
    focus: "Explain the actual problem: she needed a partner, not another surprise."
  },
  {
    speakerId: "leo",
    focus: "Offer one concrete fix and avoid making it all about his shame."
  },
  {
    speakerId: "maya",
    focus: "Let the tension soften a little, but do not erase the boundary."
  },
  {
    speakerId: "leo",
    focus: "Make a small joke that helps, then say what he will do next."
  },
  {
    speakerId: "maya",
    focus: "Admit she is tired of being the backup plan for everyone."
  },
  {
    speakerId: "leo",
    focus: "Hear that directly and respond like a friend, not a defendant."
  },
  {
    speakerId: "maya",
    focus: "Ask for a new working agreement for tomorrow morning."
  },
  {
    speakerId: "leo",
    focus: "Commit to the agreement with specifics."
  },
  {
    speakerId: "maya",
    focus: "Let in a little warmth and humor without dropping the point."
  },
  {
    speakerId: "leo",
    focus: "Close the scene with a normal, hopeful line that sounds like Leo."
  }
];

export const beatsFor = (turnCount: number): DialogueBeat[] => {
  if (turnCount <= dialogueBeats.length) {
    return dialogueBeats.slice(0, turnCount);
  }
  return Array.from({ length: turnCount }, (_, index) => dialogueBeats[index % dialogueBeats.length]);
};

export const selectVoicesForBeat = (
  self: JungianSelfProfile,
  beatIndex: number,
  count: number
): JungianSelfProfile["voices"] => {
  const voices = self.voices;
  if (count >= voices.length) {
    return voices;
  }
  return Array.from({ length: count }, (_, offset) => voices[(beatIndex + offset) % voices.length]);
};
