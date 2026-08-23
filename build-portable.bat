@echo off
rem Builds the LIGHT sidecar Python into python-engine\python so the packaged app
rem ships a real interpreter (it runs ipc_main.py AND provision_forge.py under
rem sys.executable). Only the tiny player deps go here; the heavy forge env is
rem provisioned at runtime into %LOCALAPPDATA%, never bundled.
setlocal enableextensions
set "PYVER=3.13.5"
set "ENGINE=%~dp0python-engine"
set "PYDIR=%ENGINE%\python"

rem build:portable and build:nsis each invoke build:engine, so this runs twice.
rem The first pass slims pip out of the bundle, so a naive "python present -> goto
rem deps" makes the second pass die on `pip install` (No module named pip). Instead:
rem if the bundle's already built (deps import), we're done; if it's present but
rem broken, wipe it and rebuild from scratch (which restores pip).
if exist "%PYDIR%\python.exe" (
  echo [build] light python present — verifying existing bundle ...
  "%PYDIR%\python.exe" -c "import mido,pynput,psutil,win32gui,win32con,win32process" && ( echo [build] already built, skipping & exit /b 0 )
  echo [build] present but incomplete — wiping and rebuilding
  rd /s /q "%PYDIR%" 2>nul
)

echo [build] downloading embeddable Python %PYVER% ...
mkdir "%PYDIR%" 2>nul
curl -fL -o "%PYDIR%\python-embed.zip" "https://www.python.org/ftp/python/%PYVER%/python-%PYVER%-embed-amd64.zip" || goto err
powershell -NoProfile -Command "Expand-Archive -Force '%PYDIR%\python-embed.zip' '%PYDIR%'" || goto err
del "%PYDIR%\python-embed.zip" 2>nul
for %%f in ("%PYDIR%\python*._pth") do powershell -NoProfile -Command "(Get-Content '%%f') -replace '#import site','import site' | Set-Content '%%f'"
echo [build] bootstrapping pip ...
curl -fL -o "%PYDIR%\get-pip.py" "https://bootstrap.pypa.io/get-pip.py" || goto err
"%PYDIR%\python.exe" "%PYDIR%\get-pip.py" --no-warn-script-location || goto err
del "%PYDIR%\get-pip.py" 2>nul

:deps
echo [build] installing light player deps ...
"%PYDIR%\python.exe" -m pip install --no-warn-script-location -r "%ENGINE%\requirements-player.txt" || goto err
echo [build] verifying imports (fails the build if the sidecar can't start) ...
"%PYDIR%\python.exe" -c "import mido,pynput,psutil,win32gui,win32con,win32process; print('imports OK')" || goto err

echo [build] slimming bundle (this gets re-extracted on every portable launch) ...
set "SP=%PYDIR%\Lib\site-packages"
rem pip/setuptools/wheel aren't needed at runtime; pythonwin is the pywin32 IDE;
rem the .chm is a help file; win32com/win32comext/adodbapi/isapi are COM and
rem ASP support that nothing here imports. ~25 MB removed.
for %%D in (pip pip-* setuptools setuptools-* wheel wheel-* pkg_resources pythonwin win32com win32comext adodbapi isapi) do rd /s /q "%SP%\%%D" 2>nul
del /q "%SP%\PyWin32.chm" 2>nul
for /d /r "%PYDIR%" %%P in (__pycache__) do rd /s /q "%%P" 2>nul
echo [build] light sidecar python ready at %PYDIR%
exit /b 0
:err
echo [build] FAILED
exit /b 1
