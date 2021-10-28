import { ManagerClient } from '../../client/ManagerClient';
import { MessageRunWdaResponse } from '../../../types/MessageRunWdaResponse';
import { Message } from '../../../types/Message';
import { ControlCenterCommand } from '../../../common/ControlCenterCommand';
import { ParamsWdaProxy } from '../../../types/ParamsWdaProxy';
import { ParsedUrlQuery } from 'querystring';
import { ACTION } from '../../../common/Action';
import Util from '../../Util';
import { ChannelCode } from '../../../common/ChannelCode';
import { WDAMethod } from '../../../common/WDAMethod';
import ScreenInfo from '../../ScreenInfo';
import Position from '../../Position';
import Point from '../../Point';
import { TouchHandlerListener } from '../../interactionHandler/SimpleInteractionHandler';

export type WdaProxyClientEvents = {
    'wda-status': MessageRunWdaResponse;
    connected: boolean;
};

const TAG = '[WdaProxyClient]';

export class WdaProxyClient
    extends ManagerClient<ParamsWdaProxy, WdaProxyClientEvents>
    implements TouchHandlerListener {
    public static calculatePhysicalPoint(
        screenInfo: ScreenInfo,
        screenWidth: number,
        position: Position,
    ): Point | undefined {
        // ignore the locked video orientation, the events will apply in coordinates considered in the physical device orientation
        const { videoSize, deviceRotation, contentRect } = screenInfo;
        const { right, left, bottom, top } = contentRect;
        let shortSide: number;
        if (videoSize.width >= videoSize.height) {
            shortSide = bottom - top;
        } else {
            shortSide = right - left;
        }
        const scale = shortSide / screenWidth;

        // reverse the video rotation to apply the events
        const devicePosition = position.rotate(deviceRotation);

        if (!videoSize.equals(devicePosition.screenSize)) {
            // The client sends a click relative to a video with wrong dimensions,
            // the device may have been rotated since the event was generated, so ignore the event
            return;
        }
        const { point } = devicePosition;
        const convertedX = contentRect.left + (point.x * contentRect.getWidth()) / videoSize.width;
        const convertedY = contentRect.top + (point.y * contentRect.getHeight()) / videoSize.height;

        const scaledX = Math.round(convertedX / scale);
        const scaledY = Math.round(convertedY / scale);

        return new Point(scaledX, scaledY);
    }

    private screenInfo?: ScreenInfo;
    private screenWidth = 0;
    private udid: string;
    private stopped = false;
    private commands: string[] = [];
    private hasSession = false;
    private messageId = 0;
    private wait: Map<number, { resolve: (m: Message) => void; reject: () => void }> = new Map();

    constructor(params: ParamsWdaProxy) {
        super(params);
        this.openNewConnection();
        this.udid = params.udid;
    }

    public parseParameters(params: ParsedUrlQuery): ParamsWdaProxy {
        const typedParams = super.parseParameters(params);
        const { action } = typedParams;
        if (action !== ACTION.PROXY_WDA) {
            throw Error('Incorrect action');
        }
        return { ...typedParams, action, udid: Util.parseStringEnv(params.udid) };
    }

    protected onSocketClose(e: CloseEvent): void {
        this.emit('connected', false);
        console.log(TAG, `Connection closed: ${e.reason}`);
        if (!this.stopped) {
            setTimeout(() => {
                this.openNewConnection();
            }, 2000);
        }
    }

    protected onSocketMessage(e: MessageEvent): void {
        new Response(e.data)
            .text()
            .then((text: string) => {
                const json = JSON.parse(text) as Message;
                const id = json['id'];
                const p = this.wait.get(id);
                if (p) {
                    this.wait.delete(id);
                    p.resolve(json);
                    return;
                }
                switch (json['type']) {
                    case ControlCenterCommand.RUN_WDA:
                        this.emit('wda-status', json as MessageRunWdaResponse);
                        return;
                    default:
                        throw Error('Unsupported message');
                }
            })
            .catch((error: Error) => {
                console.error(TAG, error.message);
                console.log(TAG, e.data);
            });
    }

    protected onSocketOpen(): void {
        this.emit('connected', true);
        while (this.commands.length) {
            const str = this.commands.shift();
            if (str) {
                this.sendCommand(str);
            }
        }
    }

    private sendCommand(str: string): void {
        if (this.ws && this.ws.readyState === this.ws.OPEN) {
            this.ws.send(str);
        } else {
            this.commands.push(str);
        }
    }

    private getNextId(): number {
        return ++this.messageId;
    }

    public async sendMessage(message: Message): Promise<Message> {
        this.sendCommand(JSON.stringify(message));
        return new Promise<Message>((resolve, reject) => {
            this.wait.set(message.id, { resolve, reject });
        });
    }

    public setScreenInfo(screenInfo: ScreenInfo): void {
        this.screenInfo = screenInfo;
    }

    public getScreenInfo(): ScreenInfo | undefined {
        return this.screenInfo;
    }

    private async getScreenWidth(): Promise<number> {
        if (this.screenWidth) {
            return this.screenWidth;
        }
        const temp = await this.requestWebDriverAgent(WDAMethod.GET_SCREEN_WIDTH);
        if (temp.data.success && typeof temp.data.response === 'number') {
            return (this.screenWidth = temp.data.response);
        }
        throw Error('Invalid response');
    }

    public async pressButton(name: string): Promise<void> {
        return this.requestWebDriverAgent(WDAMethod.PRESS_BUTTON, {
            name,
        });
    }

    public async performClick(position: Position): Promise<void> {
        if (!this.screenInfo) {
            return;
        }
        const screenWidth = this.screenWidth || (await this.getScreenWidth());
        const point = WdaProxyClient.calculatePhysicalPoint(this.screenInfo, screenWidth, position);
        if (!point) {
            return;
        }
        return this.requestWebDriverAgent(WDAMethod.CLICK, {
            x: point.x,
            y: point.y,
        });
    }

    public async performScroll(from: Position, to: Position): Promise<void> {
        if (!this.screenInfo) {
            return;
        }
        const wdaScreen = this.screenWidth || (await this.getScreenWidth());
        const fromPoint = WdaProxyClient.calculatePhysicalPoint(this.screenInfo, wdaScreen, from);
        const toPoint = WdaProxyClient.calculatePhysicalPoint(this.screenInfo, wdaScreen, to);
        if (!fromPoint || !toPoint) {
            return;
        }
        return this.requestWebDriverAgent(WDAMethod.SCROLL, {
            from: {
                x: fromPoint.x,
                y: fromPoint.y,
            },
            to: {
                x: toPoint.x,
                y: toPoint.y,
            },
        });
    }

    public async runWebDriverAgent(): Promise<MessageRunWdaResponse> {
        const message: Message = {
            id: this.getNextId(),
            type: ControlCenterCommand.RUN_WDA,
            data: {
                udid: this.udid,
            },
        };
        const response = await this.sendMessage(message);
        this.hasSession = true;
        return response as MessageRunWdaResponse;
    }

    public async requestWebDriverAgent(method: WDAMethod, args?: any): Promise<any> {
        if (!this.hasSession) {
            throw Error('No session');
        }
        const message: Message = {
            id: this.getNextId(),
            type: ControlCenterCommand.REQUEST_WDA,
            data: {
                method,
                args,
            },
        };
        return this.sendMessage(message);
    }

    protected supportMultiplexing(): boolean {
        return true;
    }

    protected getChannelInitData(): Buffer {
        const udid = Util.stringToUtf8ByteArray(this.params.udid);
        const buffer = Buffer.alloc(4 + 4 + udid.byteLength);
        buffer.write(ChannelCode.WDAP, 'ascii');
        buffer.writeUInt32LE(udid.length, 4);
        buffer.set(udid, 8);
        return buffer;
    }

    public stop(): void {
        if (this.stopped) {
            return;
        }
        this.stopped = true;
        if (this.ws && this.ws.readyState === this.ws.OPEN) {
            this.ws.close();
        }
    }
}
