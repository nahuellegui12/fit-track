import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system/legacy';
import { Vibration } from 'react-native';

export type RecordedMealAudio = {
  base64: string;
  mimeType: string;
};

export interface MealAudioRecorder {
  start(): Promise<void>;
  stop(): Promise<RecordedMealAudio>;
  cancel(): Promise<void>;
}

class NativeMealAudioRecorder implements MealAudioRecorder {
  private recording: Audio.Recording | null = null;

  async start(): Promise<void> {
    const permission = await Audio.requestPermissionsAsync();
    if (!permission.granted) {
      throw new Error('Activa el permiso de microfono para dictar comidas.');
    }

    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
    });

    const recording = new Audio.Recording();
    await recording.prepareToRecordAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
    await recording.startAsync();
    this.recording = recording;
  }

  async stop(): Promise<RecordedMealAudio> {
    const recording = this.recording;
    if (!recording) {
      throw new Error('No hay una grabacion activa.');
    }

    this.recording = null;
    await recording.stopAndUnloadAsync();
    await Audio.setAudioModeAsync({ allowsRecordingIOS: false });

    const uri = recording.getURI();
    if (!uri) {
      throw new Error('No se pudo obtener el audio grabado.');
    }

    const base64 = await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
    });

    return { base64, mimeType: 'audio/m4a' };
  }

  async cancel(): Promise<void> {
    const recording = this.recording;
    this.recording = null;
    if (recording) {
      await recording.stopAndUnloadAsync();
    }
    await Audio.setAudioModeAsync({ allowsRecordingIOS: false });
  }
}

export function createMealAudioRecorder(): MealAudioRecorder {
  return new NativeMealAudioRecorder();
}

export function playRecordingFeedback(): void {
  Vibration.vibrate(25);
}
