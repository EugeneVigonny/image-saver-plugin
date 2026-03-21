import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
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
        content_scripts: [
            {
                matches: ["<all_urls>"],
                js: ["content-scripts/content.js"],
            },
        ],
    },
});
