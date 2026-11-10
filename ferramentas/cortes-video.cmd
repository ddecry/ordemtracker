@echo off
rem roda o cortes-video.js pelo agendador do Windows e guarda o que aconteceu em dados\cortes-pc.log
cd /d "%~dp0.."
node ferramentas\cortes-video.js >> dados\cortes-pc.log 2>&1
