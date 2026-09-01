interface Window {
  readonly valeLoot?: {
    onAlert(listener: (name: string) => void): () => void;
  };
}
