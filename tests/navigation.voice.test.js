// Tests for the NavigationVoiceService abstraction
// (public/js/services/navigation/voice.js). A fake speechSynthesis drives the
// Web Speech adapter; the null adapter is asserted as the honest silent
// fallback for devices without TTS.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { before } = require('node:test');

let createWebSpeechVoice;
let createNullVoice;

before(async () => {
  const mod = await import('../public/js/services/navigation/voice.js');
  ({ createWebSpeechVoice, createNullVoice } = mod);
});

function makeSynth() {
  const calls = [];
  return {
    calls,
    speak(utterance) {
      calls.push(['speak', utterance.text, utterance.lang]);
    },
    cancel() {
      calls.push(['cancel']);
    },
  };
}

test('the Web Speech adapter speaks and cancels on interrupt', () => {
  const synth = makeSynth();
  const voice = createWebSpeechVoice({
    speechSynthesis: synth,
    utteranceFactory: class {
      constructor(text) {
        this.text = text;
        this.lang = null;
      }
    },
  });
  assert.equal(voice.isAvailable(), true);
  voice.speak('Turn left.', { interrupt: true, lang: 'id-ID' });
  assert.deepEqual(synth.calls, [['cancel'], ['speak', 'Turn left.', 'id-ID']]);
  voice.speak('Arrived.');
  assert.deepEqual(synth.calls[2], ['speak', 'Arrived.', null]);
  voice.stop();
  assert.deepEqual(synth.calls[3], ['cancel']);
});

test('empty text is never spoken; a failing utterance never throws', () => {
  const synth = makeSynth();
  const voice = createWebSpeechVoice({
    speechSynthesis: synth,
    utteranceFactory: class {
      constructor() {
        throw new Error('no voice engines');
      }
    },
  });
  voice.speak('   ');
  assert.deepEqual(synth.calls, []);
  voice.speak('Turn left.'); // the throw is swallowed by the adapter
  voice.stop();
  assert.deepEqual(synth.calls, [['cancel']]);
});

test('the null adapter is silently unavailable — spoken guidance is never faked', () => {
  const voice = createNullVoice();
  assert.equal(voice.isAvailable(), false);
  assert.doesNotThrow(() => voice.speak('Turn left.'));
  assert.doesNotThrow(() => voice.stop());
});

test('missing dependencies yield the null adapter', () => {
  const voice = createWebSpeechVoice({ speechSynthesis: null, utteranceFactory: null });
  assert.equal(voice.isAvailable(), false);
});