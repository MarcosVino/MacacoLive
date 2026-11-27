# MacacoLive

Aplicativo Windows nativo em arquivo único (`~816 KB`) para compartilhamento de tela e som estéreo P2P entre amigos, sem custo de servidor e sem eco da call do Discord.

---

## Como Mandar e Usar com os Amigos

* **Arquivo único direto:** [dist/MacacoLive.exe](./dist/MacacoLive.exe) (~816 KB — não precisa instalar nada nem de pasta `wwwroot` junto; é só clicar duas vezes e abrir).
* **Para jogar no chat do Discord:** envie `dist\MacacoLive.exe` direto ou `dist\MacacoLive.zip` (~310 KB, caso o Discord barre anexo com extensão `.exe`).

---

## Como Recompilar

Na raiz do projeto, execute no PowerShell:

```powershell
.\scripts\build-portable.ps1
```

O script compila a interface (`ui/`), embute todos os arquivos web em memória (`src/native/embedded_assets.h`) e gera `dist\MacacoLive.exe` e `dist\MacacoLive.zip` em C++20 estático.
