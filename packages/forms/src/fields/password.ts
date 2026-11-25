/** Texts of a password input's show / hide button (Issue #944). Functions, so a caller always calls `t.key()`. */
export interface PasswordInputMessages {
	/** Accessible name of the button while the password is hidden (pressing it shows the password). */
	show: () => string;
	/** Accessible name of the button while the password is shown (pressing it hides it again). */
	hide: () => string;
}

export const defaultPasswordInputMessages: PasswordInputMessages = {
	show: () => 'パスワードを表示',
	hide: () => 'パスワードを隠す'
};
