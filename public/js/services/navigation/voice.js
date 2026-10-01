// NavigationVoiceService — the voice/TTS abstraction for navigation.
//
// Interface (the only thing navigation logic may depend on):
//   isAvailable()            -> boolean
//   speak(text, { interrupt, lang })  -> void (never throws)
//   stop()                   -> void
//
// Two implementations ship:
//   - createWebSpeechVoice: the browser's built-in speech synthesis. Real TTS
//     where the device offers it; a failed utterance is swallowed so voice
//     trouble can never break guidance.
//   - createNullVoice: a silent no-op for devices without speech synthesis.
//     Spoken navigation is never simulated: when TTS is unavailable the UI
//     says so and nothing speaks.
//
// TODO(voice): verify speechSynthesis inside the Homeroom app frame. If the
// frame does not provide it, the null adapter is the shipped behavior and the
// navigation view shows voice as unavailable.
'use strict';

export function createWebSpeechVoice({ speechSynthesis = null, utteranceFactory = null } = {}) {
  const synth = speechSynthesis ||
    (typeof window !== 'undefined' && window.speechSynthesis ? window.speechSynthesis : null);
  const Utterance = utteranceFactory ||
    (typeof window !== 'undefined' && typeof window.SpeechSynthesisUtterance === 'function'
      ? window.SpeechSynthesisUtterance
      : null);
  if (!synth || typeof synth.speak !== 'function' || !Utterance) {
    return createNullVoice();
  }
  return {
    isAvailable() {
      return true;
    },
    speak(text, { interrupt = false, lang = null } = {}) {
      if (typeof text !== 'string' || !text.trim()) return;
      try {
        if (interrupt) synth.cancel();
        const utterance = new Utterance(text);
        if (lang) utterance.lang = lang;
        synth.speak(utterance);
      } catch {
        /* a failed utterance must never break navigation */
      }
    },
    stop() {
      try {
        synth.cancel();
      } catch {
        /* ignore */
      }
    },
  };
}

export function createNullVoice() {
  return {
    isAvailable() {
      return false;
    },
    speak() {
      /* silent: no TTS on this device, and spoken navigation is never faked */
    },
    stop() {},
  };
}

// The production default: Web Speech when the device offers it, the null
// adapter otherwise.
export function createNavigationVoice() {
  if (typeof window !== 'undefined' && window.speechSynthesis && typeof window.SpeechSynthesisUtterance === 'function') {
    return createWebSpeechVoice({});
  }
  return createNullVoice();
}