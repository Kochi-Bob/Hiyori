import { Capacitor, registerPlugin } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

export interface VoiceStatus { available: boolean; message: string }
const guidance = '未找到日语离线语音。请在系统设置 → 语言和输入法 → 文字转语音中安装日语离线语音包，再返回重试。';
const OfflineSpeech = registerPlugin<{
  getVoiceStatus(): Promise<VoiceStatus>;
  speak(options: { text: string }): Promise<void>;
}>('OfflineSpeech');

async function localVoice(): Promise<SpeechSynthesisVoice | undefined> {
  if (!('speechSynthesis' in window)) return undefined;
  const synth = window.speechSynthesis;
  if (!synth.getVoices().length) await new Promise<void>(resolve => {
    const done = () => { synth.removeEventListener('voiceschanged', done); clearTimeout(timer); resolve(); };
    const timer = window.setTimeout(done, 1200);
    synth.addEventListener('voiceschanged', done);
  });
  return synth.getVoices().find(voice => /^ja(?:-|$)/i.test(voice.lang) && voice.localService);
}

export async function getVoiceStatus(): Promise<VoiceStatus> {
  if (Capacitor.isNativePlatform()) {
    try { return await OfflineSpeech.getVoiceStatus(); }
    catch { return { available: false, message: guidance }; }
  }
  return (await localVoice()) ? { available: true, message: '日语离线语音可用' } : { available: false, message: guidance };
}

export async function speak(text: string): Promise<void> {
  if (!text.trim()) return;
  if (Capacitor.isNativePlatform()) { await OfflineSpeech.speak({ text }); return; }
  const voice = await localVoice();
  if (!voice) throw new Error(guidance);
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.voice = voice;
  utterance.lang = 'ja-JP';
  utterance.rate = 0.85;
  await new Promise<void>((resolve, reject) => {
    utterance.onend = () => resolve();
    utterance.onerror = event => reject(new Error(`点读未完成：${event.error}`));
    window.speechSynthesis.speak(utterance);
  });
}

export async function saveDownload(blob: Blob, filename: string): Promise<void> {
  const safeName = filename.replace(/[\\/:*?"<>|]/g, '_');
  if (Capacitor.isNativePlatform()) {
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.readAsDataURL(blob);
    });
    const file = await Filesystem.writeFile({ path: `exports/${safeName}`, data, directory: Directory.Cache, recursive: true });
    await Share.share({ title: safeName, files: [file.uri], dialogTitle: '保存或分享备份' });
    return;
  }
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = safeName;
  document.body.append(anchor); anchor.click(); anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
