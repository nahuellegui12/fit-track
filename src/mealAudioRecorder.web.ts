export type RecordedMealAudio = {
  base64: string;
  mimeType: string;
};

export interface MealAudioRecorder {
  start(): Promise<void>;
  stop(): Promise<RecordedMealAudio>;
  cancel(): Promise<void>;
}

const MIME_TYPE_CANDIDATES = [
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/webm;codecs=opus',
  'audio/webm',
];

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('No se pudo leer el audio grabado.'));
    reader.onloadend = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('No se pudo convertir el audio grabado.'));
        return;
      }
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(blob);
  });
}

class WebMealAudioRecorder implements MealAudioRecorder {
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];

  async start(): Promise<void> {
    if (!window.isSecureContext && window.location.hostname !== 'localhost') {
      throw new Error('El microfono requiere una conexion HTTPS.');
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      throw new Error('Este navegador no permite grabar audio.');
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      throw new Error('Activa el permiso de microfono para dictar comidas.');
    }

    const mimeType = MIME_TYPE_CANDIDATES.find((candidate) => MediaRecorder.isTypeSupported(candidate));
    this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    this.chunks = [];
    this.recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        this.chunks.push(event.data);
      }
    };
    this.recorder.start();
  }

  async stop(): Promise<RecordedMealAudio> {
    const recorder = this.recorder;
    if (!recorder || recorder.state === 'inactive') {
      throw new Error('No hay una grabacion activa.');
    }

    const blob = await new Promise<Blob>((resolve, reject) => {
      recorder.onerror = () => reject(new Error('No se pudo finalizar la grabacion.'));
      recorder.onstop = () => resolve(new Blob(this.chunks, { type: recorder.mimeType || 'audio/webm' }));
      recorder.stop();
    });

    this.releaseMedia();
    if (blob.size === 0) {
      throw new Error('No se detecto audio para analizar.');
    }

    return {
      base64: await blobToBase64(blob),
      mimeType: blob.type.split(';')[0] || 'audio/webm',
    };
  }

  async cancel(): Promise<void> {
    const recorder = this.recorder;
    if (recorder && recorder.state !== 'inactive') {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.stop();
    }
    this.releaseMedia();
  }

  private releaseMedia(): void {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
  }
}

export function createMealAudioRecorder(): MealAudioRecorder {
  return new WebMealAudioRecorder();
}

export function playRecordingFeedback(): void {
  navigator.vibrate?.(25);
}
