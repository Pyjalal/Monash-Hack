interface CargoLensChromeMessageSender {
  tab?: { id?: number };
}

interface CargoLensChromeRuntime {
  sendMessage(message: unknown): Promise<unknown>;
  openOptionsPage(): Promise<void>;
  onMessage: {
    addListener(listener: (message: unknown, sender: CargoLensChromeMessageSender, sendResponse: (response: unknown) => void) => void | boolean): void;
    removeListener(listener: (message: unknown, sender: CargoLensChromeMessageSender, sendResponse: (response: unknown) => void) => void | boolean): void;
  };
}

interface CargoLensChromeStorageArea {
  get(keys?: Record<string, unknown>): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
}

interface CargoLensChromeTabs {
  sendMessage(tabId: number, message: unknown): Promise<unknown>;
  query(queryInfo: Record<string, unknown>): Promise<Array<{ id?: number }>>;
}

interface CargoLensChromeCommands {
  onCommand: { addListener(listener: (command: string) => void): void };
}

declare const chrome: {
  runtime: CargoLensChromeRuntime;
  storage: { sync: CargoLensChromeStorageArea; session: CargoLensChromeStorageArea };
  tabs: CargoLensChromeTabs;
  commands: CargoLensChromeCommands;
};
