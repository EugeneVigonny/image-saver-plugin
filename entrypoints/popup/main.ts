import './style.css';
import typescriptLogo from '@/assets/typescript.svg';
import wxtLogo from '/wxt.svg';
import { setupCounter } from '@/components/counter';
import {
    runtime_message_types,
    type GetQueueStateMessage,
    type QueueState,
    type RuntimeResponse,
} from '@/entrypoints/shared/contracts';

type QueueStateResult = Readonly<{
    queue_state: QueueState;
}>;

/**
 * Запрашивает в background текущее состояние очереди сохранения.
 */
export async function send_get_queue_state_message(): Promise<RuntimeResponse<QueueStateResult>> {
    const message: GetQueueStateMessage = {
        type: runtime_message_types.get_queue_state,
    };

    const response = await browser.runtime.sendMessage(message);
    return response as RuntimeResponse<QueueStateResult>;
}

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <div>
    <a href="https://wxt.dev" target="_blank">
      <img src="${wxtLogo}" class="logo" alt="WXT logo" />
    </a>
    <a href="https://www.typescriptlang.org/" target="_blank">
      <img src="${typescriptLogo}" class="logo vanilla" alt="TypeScript logo" />
    </a>
    <h1>WXT + TypeScript</h1>
    <div class="card">
      <button id="counter" type="button"></button>
    </div>
    <p class="read-the-docs">
      Click on the WXT and TypeScript logos to learn more
    </p>
  </div>
`;

setupCounter(document.querySelector<HTMLButtonElement>('#counter')!);
