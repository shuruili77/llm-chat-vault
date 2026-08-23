/**
 * Theme manager for Light / Night (Dark) mode toggle and persistence
 */

export class ThemeManager {
    static STORAGE_KEY = 'llm_viewer_theme';

    constructor() {
        this.theme = this.getStoredTheme() || this.getSystemPreference();
        this.toggleBtn = document.getElementById('theme-toggle-btn');
        this.mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

        this.init();
    }

    /**
     * Initialize theme application and listeners
     */
    init() {
        // Apply current theme to <html>
        this.applyTheme(this.theme);

        // Setup button listener
        if (this.toggleBtn) {
            this.toggleBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.toggleTheme();
            });
            this.updateToggleUI();
        }

        // Listen for OS system theme changes
        if (this.mediaQuery && this.mediaQuery.addEventListener) {
            this.mediaQuery.addEventListener('change', (e) => {
                // Only follow system if user has not explicitly stored a preference in this session
                const stored = this.getStoredTheme();
                if (!stored) {
                    this.setTheme(e.matches ? 'dark' : 'light', false);
                }
            });
        }

        // Listen for keyboard shortcut (Ctrl+Shift+D or Alt+T)
        document.addEventListener('keydown', (e) => {
            if ((e.ctrlKey && e.shiftKey && e.key === 'D') || (e.altKey && e.key.toLowerCase() === 't')) {
                e.preventDefault();
                this.toggleTheme();
            }
        });
    }

    /**
     * Get stored theme from localStorage
     * @returns {string|null}
     */
    getStoredTheme() {
        try {
            return localStorage.getItem(ThemeManager.STORAGE_KEY);
        } catch (e) {
            return null;
        }
    }

    /**
     * Detect OS dark mode preference
     * @returns {'dark'|'light'}
     */
    getSystemPreference() {
        if (this.mediaQuery && this.mediaQuery.matches) {
            return 'dark';
        }
        return 'light';
    }

    /**
     * Apply theme class/attribute to root document element
     * @param {'dark'|'light'} theme
     */
    applyTheme(theme) {
        const root = document.documentElement;
        if (theme === 'dark') {
            root.setAttribute('data-theme', 'dark');
            root.classList.add('dark');
            root.classList.remove('light');
        } else {
            root.setAttribute('data-theme', 'light');
            root.classList.add('light');
            root.classList.remove('dark');
        }
        this.theme = theme;
        this.updateToggleUI();

        // Dispatch custom event for components that need to respond
        window.dispatchEvent(new CustomEvent('theme-changed', { detail: { theme } }));
    }

    /**
     * Set active theme and optionally persist
     * @param {'dark'|'light'} theme
     * @param {boolean} persist
     */
    setTheme(theme, persist = true) {
        if (persist) {
            try {
                localStorage.setItem(ThemeManager.STORAGE_KEY, theme);
            } catch (e) {
                console.warn('Failed to save theme in localStorage:', e);
            }
        }
        this.applyTheme(theme);
    }

    /**
     * Toggle between light and dark modes
     */
    toggleTheme() {
        const nextTheme = this.theme === 'dark' ? 'light' : 'dark';
        this.setTheme(nextTheme, true);
    }

    /**
     * Update toggle button icon and tooltip
     */
    updateToggleUI() {
        if (!this.toggleBtn) {
            this.toggleBtn = document.getElementById('theme-toggle-btn');
            if (!this.toggleBtn) return;
        }

        const isDark = this.theme === 'dark';
        this.toggleBtn.setAttribute('title', isDark ? 'Switch to Light mode (Alt+T)' : 'Switch to Night mode (Alt+T)');
        this.toggleBtn.setAttribute('aria-label', isDark ? 'Switch to Light mode' : 'Switch to Night mode');

        // Render Moon icon when in light mode (to indicate clicking will turn on night mode)
        // and Sun icon when in dark mode (to indicate clicking will switch to daylight mode)
        if (isDark) {
            this.toggleBtn.innerHTML = `
                <svg class="theme-icon sun-icon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 16 16">
                    <path d="M8 11a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm0 1a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM8 0a.5.5 0 0 1 .5.5v2a.5.5 0 0 1-1 0v-2A.5.5 0 0 1 8 0zm0 13a.5.5 0 0 1 .5.5v2a.5.5 0 0 1-1 0v-2A.5.5 0 0 1 8 13zm8-5a.5.5 0 0 1-.5.5h-2a.5.5 0 0 1 0-1h2a.5.5 0 0 1 .5.5zM3 8a.5.5 0 0 1-.5.5h-2a.5.5 0 0 1 0-1h2A.5.5 0 0 1 3 8zm10.657-5.657a.5.5 0 0 1 0 .707l-1.414 1.415a.5.5 0 1 1-.707-.708l1.414-1.414a.5.5 0 0 1 .707 0zm-9.193 9.193a.5.5 0 0 1 0 .707L3.05 13.657a.5.5 0 0 1-.707-.707l1.414-1.414a.5.5 0 0 1 .707 0zm9.193 2.121a.5.5 0 0 1-.707 0l-1.414-1.414a.5.5 0 0 1 .707-.707l1.414 1.414a.5.5 0 0 1 0 .707zM4.464 4.465a.5.5 0 0 1-.707 0L2.343 3.05a.5.5 0 1 1 .707-.707l1.414 1.414a.5.5 0 0 1 0 .708z"/>
                </svg>
                <span class="theme-label-text">Light</span>
            `;
            this.toggleBtn.classList.add('theme-dark-active');
        } else {
            this.toggleBtn.innerHTML = `
                <svg class="theme-icon moon-icon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 16 16">
                    <path d="M6 .278a.768.768 0 0 1 .08.858 7.208 7.208 0 0 0-.878 3.46c0 4.021 3.278 7.277 7.318 7.277.527 0 1.04-.055 1.533-.16a.787.787 0 0 1 .81.316.733.733 0 0 1-.031.893A8.349 8.349 0 0 1 8.344 16C3.734 16 0 12.286 0 7.71 0 4.266 2.114 1.312 5.124.06A.752.752 0 0 1 6 .278zM4.858 1.311A7.269 7.269 0 0 0 1.02 7.71c0 4.013 3.242 7.25 7.324 7.25 2.148 0 4.072-.916 5.422-2.384a8.28 8.28 0 0 1-8.908-11.265z"/>
                </svg>
                <span class="theme-label-text">Night</span>
            `;
            this.toggleBtn.classList.remove('theme-dark-active');
        }
    }
}
