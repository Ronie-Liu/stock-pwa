@echo off
cd /d "c:\Users\28670\.trae-cn\work\6a1bafa1d33f96294df4bab3\stock-pwa-test2"
py scripts\export_selection.py >> "%USERPROFILE%\Desktop\selection_export.log" 2>&1
echo [%date% %time%] Done >> "%USERPROFILE%\Desktop\selection_export.log"
