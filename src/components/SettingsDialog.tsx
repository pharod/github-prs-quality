import { useEffect, useState } from "react";

interface SettingsDialogProps {
  isOpen: boolean;
  token: string;
  rememberToken: boolean;
  onClose: () => void;
  onSave: (token: string, remember: boolean) => void;
}

const SettingsDialog = ({
  isOpen,
  token,
  rememberToken,
  onClose,
  onSave,
}: SettingsDialogProps) => {
  const [draftToken, setDraftToken] = useState(token);
  const [remember, setRemember] = useState(rememberToken);

  useEffect(() => {
    if (isOpen) {
      setDraftToken(token);
      setRemember(rememberToken);
    }
  }, [isOpen, token, rememberToken]);

  if (!isOpen) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <h2>Settings</h2>
          <button className="ghost" onClick={onClose}>
            Close
          </button>
        </div>
        <label className="field">
          <span>GitHub Token</span>
          <input
            type="password"
            placeholder="ghp_..."
            value={draftToken}
            onChange={(event) => setDraftToken(event.target.value)}
          />
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={remember}
            onChange={(event) => setRemember(event.target.checked)}
          />
          <span>Remember token on this device</span>
        </label>
        <div className="modal-actions">
          <button
            className="primary"
            onClick={() => onSave(draftToken.trim(), remember)}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
};

export default SettingsDialog;
