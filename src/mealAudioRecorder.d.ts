export type RecordedMealAudio = {
  base64: string;
  mimeType: string;
};

export interface MealAudioRecorder {
  start(): Promise<void>;
  stop(): Promise<RecordedMealAudio>;
  cancel(): Promise<void>;
}

export function createMealAudioRecorder(): MealAudioRecorder;
export function playRecordingFeedback(): void;
