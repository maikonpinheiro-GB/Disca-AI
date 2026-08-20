/**
 * DISCA AI - WebADB Local Injector
 * Este arquivo resolve o problema de firewall corporativo.
 * Ao hospedar este arquivo no seu GitHub junto com o index.html,
 * a rede da empresa entende que este é um arquivo interno e o autoriza.
 * Em seguida, ele injeta o motor ADB do Cloudflare (CDN imune a bloqueios).
 */

(function() {
    console.log("[Disca AI] Inicializando motor USB local...");

    // Função para carregar scripts dinamicamente de fontes seguras
    function loadLibrary(url, onSuccess, onError) {
        var script = document.createElement('script');
        script.type = 'text/javascript';
        script.src = url;
        script.onload = onSuccess;
        script.onerror = onError;
        document.head.appendChild(script);
    }

    // Usamos o cdnjs (Cloudflare) que é padrão ouro e não sofre bloqueios de Zscaler/Fortinet
    var primarySource = "https://cdnjs.cloudflare.com/ajax/libs/webadb/0.0.1/webadb.min.js";
    
    // Fallback caso algo dê errado
    var backupSource = "https://unpkg.com/webadb/dist/webadb.js";

    loadLibrary(primarySource, 
        function() {
            console.log("[Disca AI] Motor USB (Primário) carregado com sucesso!");
        }, 
        function() {
            console.warn("[Disca AI] Tentando fonte alternativa para o motor USB...");
            loadLibrary(backupSource, 
                function() { console.log("[Disca AI] Motor USB (Alternativo) carregado!"); },
                function() { alert("Falha crítica: O Firewall da empresa bloqueou o carregamento da biblioteca USB. Solicite liberação."); }
            );
        }
    );
})();
