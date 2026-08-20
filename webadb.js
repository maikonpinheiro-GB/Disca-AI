(function(global) {
    'use strict';

    // Comandos de cabeçalho do protocolo ADB
    const A_CNXN = 0x4e584e43;
    const A_OPEN = 0x4e45504f;
    const A_OKAY = 0x59414b4f;
    const A_CLSE = 0x45534c43;
    const A_WRTE = 0x45545257;
    const A_AUTH = 0x48545541;

    const ADB_VERSION = 0x01000000;
    const MAX_PAYLOAD = 4096;

    class NativeAdbDriver {
        constructor() {
            this.device = null;
            this.interfaceNumber = 0;
            this.epIn = null;
            this.epOut = null;
            this.localId = 1;
            this.isConnected = false;
        }

        async open() {
            if (!navigator.usb) {
                throw new Error("Seu navegador não suporta WebUSB. Utilize o Google Chrome ou Microsoft Edge.");
            }

            try {
                // Solicita seleção de dispositivo USB com filtro Android/Samsung
                this.device = await navigator.usb.requestDevice({
                    filters: [
                        { classCode: 255, subclassCode: 66, protocolCode: 1 },
                        { vendorId: 0x04e8 } // Samsung Vendor ID
                    ]
                });
            } catch (e) {
                // Caso o filtro falhe, abre seleção para qualquer dispositivo USB
                this.device = await navigator.usb.requestDevice({ filters: [] });
            }

            if (!this.device) {
                throw new Error("Nenhum celular foi selecionado na janela do navegador.");
            }

            await this.device.open();
            if (this.device.configuration === null) {
                await this.device.selectConfiguration(1);
            }

            let adbInterface = null;
            for (const conf of this.device.configurations) {
                for (const intf of conf.interfaces) {
                    for (const alt of intf.alternates) {
                        if (alt.interfaceClass === 255 && alt.interfaceSubclass === 66 && alt.interfaceProtocol === 1) {
                            adbInterface = intf;
                            break;
                        }
                    }
                }
            }

            if (!adbInterface && this.device.configuration.interfaces.length > 0) {
                adbInterface = this.device.configuration.interfaces[0];
            }

            if (!adbInterface) {
                throw new Error("Interface ADB não encontrada. Certifique-se de ativar a Depuração USB no celular.");
            }

            this.interfaceNumber = adbInterface.interfaceNumber;
            try {
                await this.device.claimInterface(this.interfaceNumber);
            } catch (err) {
                // Interface já reinvindicada
            }

            const endpoints = adbInterface.alternates[0].endpoints;
            for (const ep of endpoints) {
                if (ep.direction === 'in') this.epIn = ep.endpointNumber;
                if (ep.direction === 'out') this.epOut = ep.endpointNumber;
            }

            return this;
        }

        async connectAdb(banner = "host::", authCallback = null) {
            const payload = new TextEncoder().encode(banner + "\0");
            await this.sendPacket(A_CNXN, ADB_VERSION, MAX_PAYLOAD, payload);

            try {
                let res = await this.readPacket();
                if (res.cmd === A_AUTH && authCallback) {
                    authCallback();
                }
            } catch(e) {
                console.warn("[Disca AI] Aguardando confirmação do celular...");
            }

            this.isConnected = true;
            return this;
        }

        async sendPacket(cmd, arg0, arg1, data = new Uint8Array(0)) {
            const header = new ArrayBuffer(24);
            const view = new DataView(header);
            
            let checksum = 0;
            for (let i = 0; i < data.length; i++) checksum += data[i];
            checksum = checksum & 0xffffffff;

            view.setUint32(0, cmd, true);
            view.setUint32(4, arg0, true);
            view.setUint32(8, arg1, true);
            view.setUint32(12, data.length, true);
            view.setUint32(16, checksum, true);
            view.setUint32(20, (cmd ^ 0xffffffff) >>> 0, true);

            const buffer = new Uint8Array(24 + data.length);
            buffer.set(new Uint8Array(header), 0);
            buffer.set(data, 24);

            await this.device.transferOut(this.epOut, buffer);
        }

        async readPacket() {
            const res = await this.device.transferIn(this.epIn, 24);
            if (!res.data || res.data.byteLength < 24) {
                return { cmd: 0, arg0: 0, arg1: 0, data: new Uint8Array(0) };
            }
            const view = new DataView(res.data.buffer);
            const cmd = view.getUint32(0, true);
            const arg0 = view.getUint32(4, true);
            const arg1 = view.getUint32(8, true);
            const len = view.getUint32(12, true);

            let payload = new Uint8Array(0);
            if (len > 0) {
                const dataRes = await this.device.transferIn(this.epIn, len);
                if (dataRes.data) {
                    payload = new Uint8Array(dataRes.data.buffer);
                }
            }
            return { cmd, arg0, arg1, data: payload };
        }

        async shell(command) {
            const self = this;
            const currentLocalId = this.localId++;
            
            if (command) {
                const payload = new TextEncoder().encode("shell:" + command + "\0");
                await this.sendPacket(A_OPEN, currentLocalId, 0, payload);
                
                return {
                    receive: async () => {
                        try { return await self.readPacket(); } catch(e) { return null; }
                    },
                    write: async (str) => {
                        const data = new TextEncoder().encode(str);
                        await self.sendPacket(A_WRTE, currentLocalId, 0, data);
                    }
                };
            } else {
                const payload = new TextEncoder().encode("shell:\0");
                await this.sendPacket(A_OPEN, currentLocalId, 0, payload);

                return {
                    write: async (cmdStr) => {
                        const data = new TextEncoder().encode(cmdStr);
                        await self.sendPacket(A_WRTE, currentLocalId, 0, data);
                    },
                    receive: async () => {
                        try { return await self.readPacket(); } catch(e) { return null; }
                    }
                };
            }
        }
    }

    global.Adb = {
        open: async function(type = "WebUSB") {
            const client = new NativeAdbDriver();
            return await client.open();
        }
    };

    console.log("[Disca AI] Motor USB Nativo carregado com sucesso sem dependências externas.");

})(typeof window !== 'undefined' ? window : this);
