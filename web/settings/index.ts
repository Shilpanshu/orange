declare const orange: { invoke<T>(channel: string, ...args: unknown[]): Promise<T> };

orange.invoke<string>('app:version').then((v) => (document.getElementById('ver')!.textContent = v));
