import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
    dev: {
        server: {
            port: 3000,
            origin: "http://localhost:3000",
        },
    },
    webExt: {
        /** Вкладка при старте `wxt` — иначе часто открывается пустая (about:blank). */
        startUrls: ["http://localhost:3000/dev-fixture.html"],
    },
    vite: () => ({
        // `WXT_*` доступны в `import.meta.env` наряду со стандартным префиксом Vite
        envPrefix: ["VITE_", "WXT_"],
    }),
    manifest: {
        name: "Image Saver Plugin",
        version: "1.0.0",
        description: "A plugin that saves images to the pc folder",
        author: {
            email: "eugene.vigonny@yandex.ru",
        },
        homepage_url: "https://github.com/EugeneVigonny/image-saver-plugin",
        permissions: [
            "activeTab",
            "scripting",
            "storage",
        ],
        host_permissions: [
            "<all_urls>",
        ],
    },
});
