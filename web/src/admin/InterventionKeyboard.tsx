import { useRef, type KeyboardEvent, type RefObject } from "react";

export type KeyboardStep =
  { type: "type"; text: string } | { type: "press"; key: string };

type Props = {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  enabled: boolean;
  helpId: string;
  onStep: (step: KeyboardStep) => void;
  onFocusChange: (focused: boolean) => void;
  onError: (message: string) => void;
};

const editingKeys = new Set([
  "Tab",
  "Enter",
  "Escape",
  "Backspace",
  "Delete",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);
const editingShortcuts = new Set(["a", "y", "z"]);
const textLimit = 10_000;

export default function InterventionKeyboard({
  inputRef,
  enabled,
  helpId,
  onStep,
  onFocusChange,
  onError,
}: Props) {
  const composing = useRef(false);

  function hasFocus(input: HTMLTextAreaElement) {
    return !input.disabled && input.ownerDocument.activeElement === input;
  }

  function sendText(text: string) {
    if (text.length > textLimit) {
      onError("单次键盘输入最多支持 10,000 个字符。");
    } else if (text) {
      onStep({ type: "type", text });
    }
  }

  function flushInput(input: HTMLTextAreaElement) {
    if (!hasFocus(input) || composing.current) return;
    const text = input.value;
    input.value = "";
    sendText(text);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!hasFocus(event.currentTarget)) return;
    // An IME can report its commit keystroke after isComposing becomes false.
    if (
      composing.current ||
      event.nativeEvent.isComposing ||
      event.keyCode === 229
    )
      return;
    if (event.currentTarget.value) flushInput(event.currentTarget);
    if (event.key === "Escape" && event.shiftKey) {
      event.preventDefault();
      event.currentTarget.blur();
      return;
    }
    if (event.getModifierState("AltGraph")) return;

    let key = event.key;
    const modifiers: string[] = [];
    if (
      (event.ctrlKey || event.metaKey) &&
      !event.altKey &&
      editingShortcuts.has(key.toLowerCase())
    ) {
      key = key.toLowerCase();
      modifiers.push("ControlOrMeta");
    } else if (editingKeys.has(key)) {
      if (event.ctrlKey) modifiers.push("Control");
      if (event.metaKey) modifiers.push("Meta");
      if (event.altKey) modifiers.push("Alt");
    } else {
      return;
    }

    if (event.shiftKey) modifiers.push("Shift");
    event.preventDefault();
    onStep({ type: "press", key: [...modifiers, key].join("+") });
  }

  return (
    <textarea
      ref={inputRef}
      className="intervention-keyboard"
      aria-label="接管浏览器键盘"
      aria-describedby={helpId}
      disabled={!enabled}
      rows={1}
      autoComplete="off"
      autoCapitalize="off"
      autoCorrect="off"
      spellCheck={false}
      onFocus={() => onFocusChange(true)}
      onBlur={(event) => {
        composing.current = false;
        event.currentTarget.value = "";
        onFocusChange(false);
      }}
      onKeyDown={handleKeyDown}
      onCompositionStart={() => {
        composing.current = true;
      }}
      onCompositionEnd={(event) => {
        composing.current = false;
        const input = event.currentTarget;
        // Some browsers send the final input event after compositionend.
        window.setTimeout(() => flushInput(input), 0);
      }}
      onInput={(event) => {
        if (!(event.nativeEvent as InputEvent).isComposing)
          flushInput(event.currentTarget);
      }}
      onPaste={(event) => {
        if (!hasFocus(event.currentTarget) || composing.current) return;
        event.preventDefault();
        if (event.currentTarget.value) flushInput(event.currentTarget);
        sendText(event.clipboardData.getData("text/plain"));
      }}
    />
  );
}
