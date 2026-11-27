import type en from "../../messages/en.json";

type Flatten<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Flatten<T[K], `${P}${K}.`>;
}[keyof T & string];

export type MessageKey = Flatten<typeof en>;

export interface Msg {
  key: MessageKey;
  vars?: Record<string, string | number>;
}
