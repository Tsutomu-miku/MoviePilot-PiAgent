import { useEffect, useId, useRef, type ReactNode } from "react";

interface Props {
  title: string;
  onClose(): void;
  children: ReactNode;
}

export function Dialog({ title, onClose, children }: Props) {
  const element = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = element.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return (
    <dialog ref={element} className="dialog" aria-labelledby={titleId} onCancel={onClose}>
      <h2 id={titleId}>{title}</h2>
      {children}
    </dialog>
  );
}
