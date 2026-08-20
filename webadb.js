(function(global) {
    'use strict';

    // Protocol Constants
    const A_CNXN = 0x4e584e43; // CNXN
    const A_OPEN = 0x4e45504f; // OPEN
    const A_OKAY = 0x59414b4f; // OKAY
    const A_CLSE = 0x45534c43; // CLSE
    const A_WRTE = 0x45545257; // WRTE
    const A_AUTH = 0x48545541; // AUTH

    const ADB_AUTH_TOKEN = 1;
    const ADB_AUTH_SIGNATURE = 2;
    const ADB_AUTH_RSAKEY = 3;

    const ADB_VERSION = 0x01000000;
    const MAX_PAYLOAD = 4096;

    class AdbCryptoHelper {
        constructor() {
            this.keyPair = null;
        }

        async generateKeyPair() {
            if (this.keyPair) return this.keyPair;
            
            this.keyPair = await crypto.subtle.generateKey(
                {
                    name: "RSASSA-PKCS1-v1_5",
                    modulusLength: 2048,
                    publicExponent: new Uint8Array([1, 0, 1]),
                    hash: "SHA-256"
                },
                true,
                ["sign", "verify"]
            );
            return this.keyPair;
        }

        async signToken(token) {
            await this.generateKeyPair();
            const signature = await crypto.subtle.sign(
                "RSASSA-PKCS1-v1_5",
                this.keyPair.privateKey,
                token
            );
            return new Uint8Array(signature);
        }

        async getAdbPublicKeyFormat() {
            await this.generateKeyPair();
            const exported = await crypto.subtle.exportKey("jwk", this.keyPair.publicKey);
            
            // Convert Base64URL JWK modulus to BigInt
            const b64 = exported.n.replace(/-/g, '+').replace(/_/g, '/');
            const binaryStr = atob(b64);
            const modBytes = new Uint8Array(binaryStr.length);
            for (let i = 0; i < binaryStr.length; i++) {
                modBytes[i] = binaryStr.charCodeAt(i);
            }

            // Android ADB RSA Key Format (524 bytes header)
            let n = 0n;
            for (let i = 0; i < modBytes.length; i++) {
                n = (n << 8n) | BigInt(modBytes[i]);
            }

            const r32 = 1n << 32n;
            const n0 = n % r32;
            
            // Calculate n0inv = -1 / n0 mod 2^32
            let inv = 1n;
            for (let i = 0; i < 32; i++) {
                inv = (inv * (2n - n0 * inv)) % r32;
            }
            const n0inv = Number((r32 - inv) % r32);

            // Calculate RR = (2^2048)^2 mod n
            const r2048 = 1n << 2048n;
            const rr = (r2048 * r2048) % n;

            const buffer = new ArrayBuffer(524);
            const view = new DataView(buffer);
            const bytes = new Uint8Array(buffer);

            // 1. Modulus Size Words (64 = 2048 / 32)
            view.setUint32(0, 64, true);
            // 2. n0inv
            view.setUint32(4, n0inv, true);

            // 3. Modulus in Little-Endian (256 bytes)
            let tempN = n;
            for (let i = 0; i < 256; i++) {
                bytes[8 + i] = Number(tempN & 0xffn);
                tempN >>= 8n;
            }

            // 4. RR in Little-Endian (256 bytes)
            let tempRR = rr;
            for (let i = 0; i < 256; i++) {
                bytes[264 + i] = Number(tempRR & 0xffn);
                tempRR >>= 8n;
            }

            // 5. Exponent 65537
            view.setUint32(520, 65537, true);

            // Append comment name "WebADB\0"
            const nameBytes = new TextEncoder().encode("DiscaAI\0");
            const fullPayload = new Uint8Array(buffer.byteLength + nameBytes.length);
            fullPayload.set(bytes, 0);
            fullPayload.set(nameBytes, buffer.byteLength);

            return fullPayload;
        }
    }

    class WebAdbDriver {
        constructor() {
            this.device = null;
            this.epIn = null;
            this.epOut = null;
            this.interfaceNumber = 0;
            this.crypto = new AdbCryptoHelper();
            this.localId = 1;
            this.isAuthorized = false;
            this.onLogCallback = null;
        }

        log(msg, type = 'info') {
            console.log(`[Disca AI ADB] ${msg}`);
            if (this.onLogCallback) this.onLogCallback(msg, type);
        }

        async open(logger) {
            if (logger) this.onLogCallback = logger;

            if (!navigator.usb) {
                this.log("Seu navegador não possui suporte ao WebUSB. Use o Google Chrome.", "error");
                throw new Error("WebUSB não suportado neste navegador.");
            }

            this.log("Solicitando seleção de dispositivo USB...", "info");
            try {
                this.device = await navigator.usb.requestDevice({
                    filters: [
                        { classCode: 255, subclassCode: 66, protocolCode: 1 },
                        { vendorId: 0x04e8 } // Samsung Vendor ID
                    ]
                });
            } catch (e) {
                this.log("Filtro específico não retornou aparelhos. Tentando seleção geral de USB...", "warning");
                this.device = await navigator.usb.requestDevice({ filters: [] });
            }

            if (!this.device) {
                this.log("Nenhum celular foi selecionado no menu do navegador.", "error");
                throw new Error("Dispositivo USB não selecionado.");
            }

            this.log(`USB Conectado: ${this.device.productName || 'Aparelho Samsung'}`, "success");
            this.log("Dispositivo encontrado no barramento USB.", "info");

            await this.device.open();
            if (this.device.configuration === null) {
                await this.device.selectConfiguration(1);
            }

            let adbIntf = null;
            for (const conf of this.device.configurations) {
                for (const intf of conf.interfaces) {
                    for (const alt of intf.alternates) {
                        if (alt.interfaceClass === 255 && alt.interfaceSubclass === 66 && alt.interfaceProtocol === 1) {
                            adbIntf = intf;
                            break;
                        }
                    }
                }
            }

            if (!adbIntf && this.device.configuration.interfaces.length > 0) {
                adbIntf = this.device.configuration.interfaces[0];
            }

            if (!adbIntf) {
                this.log("Interface ADB não encontrada. Certifique-se de ativar a Depuração USB no celular.", "error");
                throw new Error("Interface ADB ausente.");
            }

            this.interfaceNumber = adbIntf.interfaceNumber;
            try {
                await this.device.claimInterface(this.interfaceNumber);
            } catch (err) {
                // Interface já reivindicada
            }

            const endpoints = adbIntf.alternates[0].endpoints;
            for (const ep of endpoints) {
                if (ep.direction === 'in') this.epIn = ep.endpointNumber;
                if (ep.direction === 'out') this.epOut = ep.endpointNumber;
            }

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

        async authenticate() {
            this.log("Iniciando Handshake ADB e autenticação RSA...", "info");
            
            const bannerPayload = new TextEncoder().encode("host::DiscaAI\0");
            await this.sendPacket(A_CNXN, ADB_VERSION, MAX_PAYLOAD, bannerPayload);

            let attempts = 0;
            while (attempts < 5) {
                attempts++;
                const packet = await this.readPacket();

                if (packet.cmd === A_AUTH) {
                    if (packet.arg0 === ADB_AUTH_TOKEN) {
                        this.log("Aguardando confirmação de autorização na tela do Samsung (RSA enviado)...", "warning");
                        
                        // Envia assinatura RSA
                        const signature = await this.crypto.signToken(packet.data);
                        await this.sendPacket(A_AUTH, ADB_AUTH_SIGNATURE, 0, signature);

                        // Envia Chave Pública RSA - ESTE PASSO FORÇA O POP-UP APARECER NA TELA DO SAMSUNG!
                        const pubKeyData = await this.crypto.getAdbPublicKeyFormat();
                        await this.sendPacket(A_AUTH, ADB_AUTH_RSAKEY, 0, pubKeyData);
                    }
                } else if (packet.cmd === A_CNXN) {
                    this.isAuthorized = true;
                    this.log("ADB Autorizado com Sucesso!", "success");
                    return true;
                }
            }

            if (!this.isAuthorized) {
                this.log("ADB Não Autorizado. Confirme na tela do seu celular e tente novamente.", "error");
                throw new Error("ADB Não Autorizado pelo usuário.");
            }
            return true;
        }

        async sendShellCommand(commandStr) {
            if (!this.isAuthorized) {
                this.log("Falha ao enviar comando: O celular não está com ADB Autorizado.", "error");
                return false;
            }

            try {
                const myLocalId = this.localId++;
                const payload = new TextEncoder().encode("shell:" + commandStr + "\0");
                
                this.log(`Enviando comando para o Samsung: [${commandStr}]`, "info");
                await this.sendPacket(A_OPEN, myLocalId, 0, payload);

                // Aguarda confirmação OKAY do celular
                const response = await this.readPacket();
                if (response.cmd === A_OKAY) {
                    this.log("Comando enviado e executado com sucesso no Samsung!", "success");
                    return true;
                } else {
                    this.log(`Aviso do Samsung ao executar comando. Código: ${response.cmd}`, "warning");
                    return true;
                }
            } catch (err) {
                this.log(`Falha ao enviar comando: ${err.message}`, "error");
                return false;
            }
        }
    }

    global.DiscaAdbEngine = {
        connect: async function(logger) {
            const driver = new WebAdbDriver();
            await driver.open(logger);
            await driver.authenticate();
            return driver;
        }
    };

    console.log("[Disca AI] Motor Nativo WebADB com RSA carregado com sucesso.");

})(typeof window !== 'undefined' ? window : this);
